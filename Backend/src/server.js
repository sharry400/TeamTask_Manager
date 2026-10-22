import express from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import bcrypt from "bcrypt";
import { body, param, query, validationResult } from "express-validator";
import dotenv from "dotenv";
import { pool, initDb } from "./Database.js";
import { requireAuth } from "./auth.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
});
const allowedFrontendOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedFrontendOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (process.env.NODE_ENV !== "production") {
      try {
        const { hostname, protocol } = new URL(origin);
        if (protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
          return callback(null, true);
        }
      } catch {
        return callback(null, false);
      }
    }

    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use(session({
  name: "teamflow.sid",
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0].msg,
      details: errors.array(),
    });
  }
  next();
};

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

async function teamAccess(teamId, userId) {
  const result = await pool.query(
    `SELECT t.id, t.created_by
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE t.id = $1 AND tm.user_id = $2`,
    [teamId, userId]
  );
  return result.rows[0] || null;
}

async function taskAccess(taskId, userId) {
  const result = await pool.query(
    `SELECT tasks.*
     FROM tasks
     JOIN team_members tm ON tm.team_id = tasks.team_id
     WHERE tasks.id = $1 AND tm.user_id = $2`,
    [taskId, userId]
  );
  return result.rows[0] || null;
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, service: "team-task-manager-api" });
}));

app.post(
  "/api/auth/register",
  body("name").trim().isLength({ min: 2, max: 100 }).withMessage("Name must be 2-100 characters."),
  body("email").trim().isEmail().withMessage("Enter a valid email."),
  body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters."),
  validate,
  asyncRoute(async (req, res) => {
    const name = req.body.name.trim();
    const email = req.body.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(req.body.password, 12);

    try {
      const result = await pool.query(
        "INSERT INTO users(name, email, password_hash) VALUES($1, $2, $3) RETURNING id, name, email",
        [name, email, passwordHash]
      );
      res.status(201).json({
        message: "Account created. Please log in.",
        user: result.rows[0],
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      throw error;
    }
  })
);

app.post(
  "/api/auth/login",
  body("email").trim().isEmail().withMessage("Enter a valid email."),
  body("password").isString().notEmpty().withMessage("Password is required."),
  validate,
  (req, res, next) => passport.authenticate("local", (error, user, info) => {
    if (error) return next(error);
    if (!user) return res.status(401).json({ error: info?.message || "Login failed." });
    req.login(user, (loginError) => {
      if (loginError) return next(loginError);
      res.json({ user });
    });
  })(req, res, next)
);

app.post("/api/auth/logout", (req, res, next) => {
  req.logout((logoutError) => {
    if (logoutError) return next(logoutError);
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("teamflow.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      res.json({ message: "Logged out." });
    });
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

app.get("/api/teams", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT t.id, t.name, t.description, t.created_by, t.created_at,
       (SELECT COUNT(*)::int FROM team_members tm2 WHERE tm2.team_id = t.id) AS member_count
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = $1
     ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  res.json({ teams: result.rows });
}));

app.post(
  "/api/teams",
  requireAuth,
  body("name").trim().isLength({ min: 2, max: 120 }).withMessage("Team name must be 2-120 characters."),
  body("description").optional().isString().isLength({ max: 1000 }).withMessage("Description is too long."),
  validate,
  asyncRoute(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const team = (await client.query(
        "INSERT INTO teams(name, description, created_by) VALUES($1, $2, $3) RETURNING *",
        [req.body.name.trim(), req.body.description || "", req.user.id]
      )).rows[0];
      await client.query(
        "INSERT INTO team_members(team_id, user_id, role) VALUES($1, $2, 'owner')",
        [team.id, req.user.id]
      );
      await client.query("COMMIT");
      res.status(201).json({ team });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/api/teams/:id/members",
  requireAuth,
  param("id").isInt({ min: 1 }),
  validate,
  asyncRoute(async (req, res) => {
    if (!(await teamAccess(Number(req.params.id), req.user.id))) {
      return res.status(404).json({ error: "Team not found." });
    }
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.joined_at`,
      [req.params.id]
    );
    res.json({ members: result.rows });
  })
);

app.post(
  "/api/teams/:id/members",
  requireAuth,
  param("id").isInt({ min: 1 }),
  body("email").trim().isEmail().withMessage("Enter a valid member email."),
  validate,
  asyncRoute(async (req, res) => {
    const teamId = Number(req.params.id);
    const team = await teamAccess(teamId, req.user.id);
    if (!team) return res.status(404).json({ error: "Team not found." });
    if (team.created_by !== req.user.id) {
      return res.status(403).json({ error: "Only the team creator can add members." });
    }

    const userResult = await pool.query(
      "SELECT id, name, email FROM users WHERE email = $1",
      [req.body.email.toLowerCase().trim()]
    );
    if (!userResult.rows[0]) {
      return res.status(404).json({ error: "No registered user found with that email." });
    }

    try {
      await pool.query(
        "INSERT INTO team_members(team_id, user_id, role) VALUES($1, $2, 'member')",
        [teamId, userResult.rows[0].id]
      );
      res.status(201).json({ member: userResult.rows[0] });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "That user is already a team member." });
      }
      throw error;
    }
  })
);

app.get(
  "/api/tasks",
  requireAuth,
  query("teamId").optional().isInt({ min: 1 }),
  query("assigneeId").optional().isInt({ min: 1 }),
  query("search").optional().isString().isLength({ max: 100 }),
  validate,
  asyncRoute(async (req, res) => {
    const values = [req.user.id];
    let sql = `SELECT t.id, t.team_id, t.title, t.description, t.status, t.due_date, t.assigned_to,
                      t.created_by, t.created_at, t.updated_at, tm.name AS team_name,
                      u.name AS assignee_name, u.email AS assignee_email
               FROM tasks t
               JOIN team_members mine ON mine.team_id = t.team_id AND mine.user_id = $1
               JOIN teams tm ON tm.id = t.team_id
               LEFT JOIN users u ON u.id = t.assigned_to
               WHERE 1 = 1`;
    if (req.query.teamId) {
      values.push(Number(req.query.teamId));
      sql += ` AND t.team_id = $${values.length}`;
    }
    if (req.query.assigneeId) {
      values.push(Number(req.query.assigneeId));
      sql += ` AND t.assigned_to = $${values.length}`;
    }
    if (req.query.search) {
      values.push(`%${req.query.search}%`);
      sql += ` AND (t.title ILIKE $${values.length} OR t.description ILIKE $${values.length})`;
    }
    sql += " ORDER BY t.created_at DESC";
    const result = await pool.query(sql, values);
    res.json({ tasks: result.rows });
  })
);

app.post(
  "/api/tasks",
  requireAuth,
  body("teamId").isInt({ min: 1 }).withMessage("Select a team."),
  body("title").trim().isLength({ min: 2, max: 180 }).withMessage("Task title must be 2-180 characters."),
  body("description").optional().isString().isLength({ max: 3000 }),
  body("status").optional().isIn(["todo", "in_progress", "done"]),
  body("dueDate").optional({ values: "null" }).isISO8601({ strict: true, strictSeparator: true }).withMessage("Due date must be valid."),
  body("assignedTo").optional({ values: "null" }).isInt({ min: 1 }),
  validate,
  asyncRoute(async (req, res) => {
    const teamId = Number(req.body.teamId);
    if (!(await teamAccess(teamId, req.user.id))) {
      return res.status(404).json({ error: "Team not found." });
    }
    const assignedTo = req.body.assignedTo ? Number(req.body.assignedTo) : null;
    if (assignedTo) {
      const member = await pool.query(
        "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2",
        [teamId, assignedTo]
      );
      if (!member.rowCount) {
        return res.status(400).json({ error: "Assignee must be a member of this team." });
      }
    }
    const result = await pool.query(
      `INSERT INTO tasks(team_id, title, description, status, due_date, assigned_to, created_by)
       VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        teamId,
        req.body.title.trim(),
        req.body.description || "",
        req.body.status || "todo",
        req.body.dueDate || null,
        assignedTo,
        req.user.id,
      ]
    );
    res.status(201).json({ task: result.rows[0] });
  })
);

app.patch(
  "/api/tasks/:id",
  requireAuth,
  param("id").isInt({ min: 1 }),
  body("title").optional().trim().isLength({ min: 2, max: 180 }),
  body("description").optional().isString().isLength({ max: 3000 }),
  body("status").optional().isIn(["todo", "in_progress", "done"]),
  body("dueDate").optional({ values: "null" }).isISO8601({ strict: true, strictSeparator: true }),
  body("assignedTo").optional({ values: "null" }).isInt({ min: 1 }),
  validate,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await taskAccess(id, req.user.id);
    if (!existing) return res.status(404).json({ error: "Task not found." });

    const title = req.body.title ?? existing.title;
    const description = req.body.description ?? existing.description;
    const status = req.body.status ?? existing.status;
    const dueDate = req.body.dueDate === undefined ? existing.due_date : (req.body.dueDate || null);
    const assignedTo = req.body.assignedTo === undefined
      ? existing.assigned_to
      : (req.body.assignedTo ? Number(req.body.assignedTo) : null);

    if (assignedTo) {
      const member = await pool.query(
        "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2",
        [existing.team_id, assignedTo]
      );
      if (!member.rowCount) {
        return res.status(400).json({ error: "Assignee must be a member of this team." });
      }
    }

    const result = await pool.query(
      `UPDATE tasks
       SET title = $1, description = $2, status = $3, due_date = $4, assigned_to = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [title, description, status, dueDate, assignedTo, id]
    );
    res.json({ task: result.rows[0] });
  })
);

app.delete(
  "/api/tasks/:id",
  requireAuth,
  param("id").isInt({ min: 1 }),
  validate,
  asyncRoute(async (req, res) => {
    const task = await taskAccess(Number(req.params.id), req.user.id);
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (task.created_by !== req.user.id) {
      return res.status(403).json({ error: "Only the task creator can delete this task." });
    }
    await pool.query("DELETE FROM tasks WHERE id = $1", [task.id]);
    res.json({ message: "Task deleted." });
  })
);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Server error. Check backend terminal logs." });
});

async function start() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("Set SESSION_SECRET in the backend .env file.");
  }
  await initDb();
  app.listen(PORT, () => console.log(`API ready at http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error("Backend startup failed:", error);
  process.exit(1);
});

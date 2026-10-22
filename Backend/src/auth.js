import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import { pool } from "./Database.js";

passport.use(new LocalStrategy(
  { usernameField: "email", passwordField: "password" },
  async (email, password, done) => {
    try {
      const result = await pool.query(
        "SELECT id, name, email, password_hash FROM users WHERE email = $1",
        [email.toLowerCase().trim()]
      );
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return done(null, false, { message: "Email or password is incorrect." });
      }
      return done(null, { id: user.id, name: user.name, email: user.email });
    } catch (error) {
      return done(error);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [id]
    );
    done(null, result.rows[0] || false);
  } catch (error) {
    done(error);
  }
});

export const requireAuth = (req, res, next) => {
  if (req.isAuthenticated?.()) return next();
  return res.status(401).json({ error: "Please log in first." });
};

import { betterAuth } from "better-auth";
import pg from "pg";

export const auth = betterAuth({
  database: new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
});

import { betterAuth } from "better-auth";
import pg from "pg";

export const auth = betterAuth({
  database: new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});

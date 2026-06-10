import { betterAuth } from "better-auth";
import postgres from "postgres";

// postgres.js works natively on Vercel Node.js serverless (no native bindings)
const client = postgres(process.env.DATABASE_URL!);

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL,
  database: {
    // Better Auth accepts a query function directly
    type: "pg",
    db: client,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
});

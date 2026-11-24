import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './agent/storage/schema.ts',
  out: './agent/storage/migrations',
});

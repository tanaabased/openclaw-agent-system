import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './agent/storage/installation-schema.ts',
  out: './agent/storage/installation-migrations',
});

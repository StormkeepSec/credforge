import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner (superuser) connection to the test server's `postgres` database. */
    databaseUrl: string;
  }
}

/** Same image as compose.dev.yml and docker-compose.yml. */
const POSTGRES_IMAGE = 'postgres:18-alpine';

export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    project.provide('databaseUrl', external);
    return;
  }

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('postgres')
      .withUsername('credforge')
      .withPassword('credforge')
      .start();
  } catch (error) {
    throw new Error(
      'Integration tests need PostgreSQL: start Docker (Testcontainers runs postgres:18-alpine), ' +
        'or set TEST_DATABASE_URL to a superuser connection string.\n' +
        String(error),
    );
  }
  project.provide('databaseUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

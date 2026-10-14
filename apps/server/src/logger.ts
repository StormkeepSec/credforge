import type { LoggerOptions } from 'pino';
import type { Config } from './config';

export function loggerOptions(config: Pick<Config, 'env' | 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    ...(config.env === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  };
}

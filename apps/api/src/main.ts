import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? true,
    credentials: true,
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','Idempotency-Key','X-Command-Token'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true }));
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}
bootstrap();

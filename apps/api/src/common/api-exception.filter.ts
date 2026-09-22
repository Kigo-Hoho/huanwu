import { randomUUID } from 'node:crypto';

import type { ApiErrorBody, ApiErrorCode } from '@barter/contracts';
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

const statusCodes: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: 'AUTH_REQUIRED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'ITEM_NOT_FOUND',
  [HttpStatus.CONFLICT]: 'ITEM_VERSION_CONFLICT',
};

function exceptionMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) {
    return 'Internal server error';
  }

  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }

  const message = 'message' in response ? response.message : undefined;
  return Array.isArray(message)
    ? message.join(', ')
    : typeof message === 'string'
      ? message
      : exception.message;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestIdHeader = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
      randomUUID();
    const body: ApiErrorBody = {
      code: statusCodes[status] ?? 'VALIDATION_FAILED',
      message: exceptionMessage(exception),
      requestId,
    };

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        body.details = exceptionResponse;
      }
    }

    response.setHeader('X-Request-Id', requestId);
    response.status(status).json(body);
  }
}

export class DomainError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    if (details !== undefined) this.details = details;
  }
}

export class ValidationError extends DomainError {
  code = 'validation-error';
  status = 400;
}

export class UnauthorizedError extends DomainError {
  code = 'unauthorized';
  status = 401;
}

export class ForbiddenError extends DomainError {
  code = 'forbidden';
  status = 403;
}

export class NotFoundError extends DomainError {
  code = 'not-found';
  status = 404;
}

// 版本冲突：两位管理员基于同一版本同时修改时，后到者收到 409 而不是悄悄覆盖
export class ConflictError extends DomainError {
  code = 'conflict';
  status = 409;
}

// 状态机不允许的操作（如向已发布方案发起求解）
export class StateError extends DomainError {
  code = 'invalid-state';
  status = 422;
}

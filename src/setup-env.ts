/**
 * env.ts validates at import time, which is what should happen in production but means a
 * test cannot set process.env after its imports have already run. Jest loads this first.
 */
process.env.JWT_SECRET ??= 'test-access';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-different';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.PORT ??= '3000';
process.env.REFRESH_TTL_DAYS ??= '30';

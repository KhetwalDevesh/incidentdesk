// What a service needs to know about the HTTP request behind a call, beyond who made it.
// Optional on service methods, so callers outside a request, such as tests, can omit it.
export type RequestContext = { requestId: string | null };

export const NO_REQUEST: RequestContext = { requestId: null };

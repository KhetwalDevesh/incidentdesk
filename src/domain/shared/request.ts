// What a service needs to know about the HTTP request behind a call, beyond who made it.
// Optional on service methods, so callers outside a request, such as tests, can omit it.
export type RequestContext = {
	requestId: string | null;
	// The caller's address, as the throttle keys it: an IPv4 address, an IPv6 /64 prefix, or
	// null when unknown. Spec: docs/features/login-rate-limiting.md.
	clientIp?: string | null;
};

export const NO_REQUEST: RequestContext = { requestId: null };

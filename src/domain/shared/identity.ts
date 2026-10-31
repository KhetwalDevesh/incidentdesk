export type TenantId = string & { readonly __brand: "TenantId" };

export const ROLES = ["viewer", "responder", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type Principal = {
	tenantId: TenantId;
	userId: string;
	role: Role;
};

export const canRespond = (principal: Principal): boolean => principal.role !== "viewer";

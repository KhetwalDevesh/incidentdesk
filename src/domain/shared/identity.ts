import { MEMBER_ROLES } from "../../contract/members";

export type TenantId = string & { readonly __brand: "TenantId" };

export const ROLES = MEMBER_ROLES;
export type Role = (typeof ROLES)[number];

export type Principal = {
	tenantId: TenantId;
	userId: string;
	role: Role;
};

export const canRespond = (principal: Principal): boolean => principal.role !== "viewer";

export const isAdmin = (principal: Principal): boolean => principal.role === "admin";

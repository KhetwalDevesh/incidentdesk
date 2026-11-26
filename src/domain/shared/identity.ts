import { MEMBER_ROLES } from "../../contract/members";

export type TenantId = string & { readonly __brand: "TenantId" };

export const ROLES = MEMBER_ROLES;
export type Role = (typeof ROLES)[number];

export type Principal = {
	tenantId: TenantId;
	userId: string;
	role: Role;
	// When the credential stops being valid. A realtime stream closes then. Absent for
	// credentials that do not expire, such as fixed test tokens.
	expiresAt?: Date;
};

export const isAdmin = (principal: Principal): boolean => principal.role === "admin";

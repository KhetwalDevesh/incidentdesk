import type { AccessTokenResponse } from "../contract/auth";
import type { AccessToken } from "../domain/auth/types";

export const toAccessTokenResponse = ({
	accessToken,
	expiresIn,
}: AccessToken): AccessTokenResponse => ({
	accessToken,
	tokenType: "Bearer",
	expiresIn,
});

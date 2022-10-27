import {ConfigInterface} from '../base-types';
import {SESSION_COOKIE_NAME} from '../auth/oauth/types';
import {
  abstractConvertRequest,
  Cookies,
  NormalizedResponse,
} from '../../runtime/http';
import {createSanitizeShop} from '../utils/shop-validator';
import * as ShopifyErrors from '../error';

import {createDecodeSessionToken} from './decode-session-token';
import type {GetCurrentSessionIdParams} from './types';

export function createGetJwtSessionId(config: ConfigInterface) {
  return (shop: string, userId: string): string => {
    return `${createSanitizeShop(config)(shop, true)}_${userId}`;
  };
}

export function createGetOfflineId(config: ConfigInterface) {
  return (shop: string): string => {
    return `offline_${createSanitizeShop(config)(shop, true)}`;
  };
}

export function createGetCurrentSessionId(config: ConfigInterface) {
  return async function getCurrentSessionId({
    isOnline,
    ...adapterArgs
  }: GetCurrentSessionIdParams): Promise<string | undefined> {
    const request = await abstractConvertRequest(adapterArgs);

    if (config.isEmbeddedApp) {
      const authHeader = request.headers.Authorization;
      if (authHeader) {
        const matches = (
          typeof authHeader === 'string' ? authHeader : authHeader[0]
        ).match(/^Bearer (.+)$/);
        if (!matches) {
          throw new ShopifyErrors.MissingJwtTokenError(
            'Missing Bearer token in authorization header',
          );
        }

        const jwtPayload = await createDecodeSessionToken(config)(matches[1]);
        const shop = jwtPayload.dest.replace(/^https:\/\//, '');
        if (isOnline) {
          return createGetJwtSessionId(config)(shop, jwtPayload.sub);
        } else {
          return createGetOfflineId(config)(shop);
        }
      }
    } else {
      const cookies = new Cookies(request, {} as NormalizedResponse, {
        keys: [config.apiSecretKey],
      });
      return cookies.getAndVerify(SESSION_COOKIE_NAME);
    }

    return undefined;
  };
}

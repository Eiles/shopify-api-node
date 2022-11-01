import request from 'supertest';
import {StatusCode} from '@shopify/network';

import {
  getNewTestConfig,
  queueMockResponse,
  shopify,
} from '../../__tests__/test-helper';
import {HttpWebhookHandler} from '../types';
import {Shopify} from '../../base-types';
import {InvalidDeliveryMethodError, InvalidWebhookError} from '../../error';
import {shopifyApi} from '../..';
import {Session} from '../../session/session';
import {JwtPayload} from '../../session/types';

import * as mockResponses from './responses';
import {EVENT_BRIDGE_HANDLER, HTTP_HANDLER, PUB_SUB_HANDLER} from './handlers';
import {getTestExpressApp, headers, hmac} from './utils';

const domain = 'shop1.myshopify.io';
const accessToken = 'dangit';
let session: Session;

describe('webhooks', () => {
  beforeEach(() => {
    const jwtPayload: JwtPayload = {
      iss: 'https://shop1.myshopify.io/admin',
      dest: 'https://shop1.myshopify.io',
      aud: shopify.config.apiKey,
      sub: '1',
      exp: Date.now() / 1000 + 3600,
      nbf: 1234,
      iat: 1234,
      jti: '4321',
      sid: 'abc123',
    };

    session = new Session({
      id: `shop1.myshopify.io_${jwtPayload.sub}`,
      shop: domain,
      state: 'state',
      isOnline: true,
      accessToken,
    });
  });

  it('HTTP handlers that point to the same location are merged', async () => {
    const topic = 'PRODUCTS_CREATE';
    const handler1: HttpWebhookHandler = {...HTTP_HANDLER, callback: jest.fn()};
    const handler2: HttpWebhookHandler = {...HTTP_HANDLER};
    const handler3: HttpWebhookHandler = {...HTTP_HANDLER, callback: jest.fn()};

    shopify.webhooks.addHandlers({[topic]: handler1});

    queueMockResponse(JSON.stringify(mockResponses.webhookCheckEmptyResponse));
    queueMockResponse(JSON.stringify(mockResponses.successResponse));
    await shopify.webhooks.register(session);

    expect(shopify.webhooks.getTopicsAdded()).toContain('PRODUCTS_CREATE');

    // Add a second handler
    shopify.webhooks.addHandlers({PRODUCTS_UPDATE: handler2});

    queueMockResponse(JSON.stringify(mockResponses.webhookCheckResponse));
    queueMockResponse(JSON.stringify(mockResponses.successResponse));
    await shopify.webhooks.register(session);

    expect(shopify.webhooks.getTopicsAdded()).toContain('PRODUCTS_UPDATE');
    expect(shopify.webhooks.getTopicsAdded()).toHaveLength(2);

    // Update the first handler and make sure we still have the two of them
    const consoleLogMock = jest.spyOn(console, 'log').mockImplementation();
    shopify.webhooks.addHandlers({[topic]: handler3});
    expect(consoleLogMock).toHaveBeenCalledWith(
      "Detected multiple handlers for 'PRODUCTS_CREATE', webhooks.process will call them sequentially",
    );
    consoleLogMock.mockRestore();

    queueMockResponse(
      JSON.stringify(mockResponses.webhookCheckMultiHandlerResponse),
    );
    await shopify.webhooks.register(session);

    expect(shopify.webhooks.getTopicsAdded()).toHaveLength(2);
    expect(shopify.webhooks.getHandlers(topic)).toEqual([handler1, handler3]);

    // Process an event for this handler to ensure both handlers are triggered
    const app = getTestExpressApp();
    app.post('/webhooks', async (req, res) => {
      await shopify.webhooks.process({
        rawBody: (req as any).rawBody,
        rawRequest: req,
        rawResponse: res,
      });
      res.status(StatusCode.Ok).end();
    });

    const body = JSON.stringify({});
    await request(app)
      .post('/webhooks')
      .set(headers({hmac: hmac(shopify.config.apiSecretKey, body)}))
      .send(body)
      .expect(200);

    // Both handlers should have been called
    expect(handler1.callback).toHaveBeenCalledWith(topic, session.shop, body);
    expect(handler3.callback).toHaveBeenCalledWith(topic, session.shop, body);
  });

  it('fires a single creation request for multiple HTTP handlers', async () => {
    const topic = 'PRODUCTS_CREATE';
    const handler1 = HTTP_HANDLER;
    const handler2 = HTTP_HANDLER;

    const consoleLogMock = jest.spyOn(console, 'log').mockImplementation();
    shopify.webhooks.addHandlers({[topic]: [handler1, handler2]});
    expect(consoleLogMock).toHaveBeenCalledWith(
      "Detected multiple handlers for 'PRODUCTS_CREATE', webhooks.process will call them sequentially",
    );
    consoleLogMock.mockRestore();

    expect(shopify.webhooks.getHandlers(topic)).toEqual([handler1, handler2]);

    queueMockResponse(JSON.stringify(mockResponses.webhookCheckEmptyResponse));
    queueMockResponse(JSON.stringify(mockResponses.successResponse));
    await shopify.webhooks.register(session);
  });

  it('allows multiple HTTP handlers on different addresses for the same topic, only one gets triggered by process', async () => {
    const topic = 'PRODUCTS_CREATE';
    const handler1: HttpWebhookHandler = {
      ...HTTP_HANDLER,
      callbackUrl: '/webhooks1',
      callback: jest.fn(),
    };
    const handler2: HttpWebhookHandler = {
      ...HTTP_HANDLER,
      callbackUrl: '/webhooks2',
      callback: jest.fn(),
    };

    shopify.webhooks.addHandlers({[topic]: [handler1, handler2]});

    queueMockResponse(JSON.stringify(mockResponses.webhookCheckEmptyResponse));
    queueMockResponse(JSON.stringify(mockResponses.successResponse));
    queueMockResponse(JSON.stringify(mockResponses.successResponse));
    await shopify.webhooks.register(session);

    const app = getTestExpressApp();
    app.post('/webhooks1', async (req, res) => {
      await shopify.webhooks.process({
        rawBody: (req as any).rawBody,
        rawRequest: req,
        rawResponse: res,
      });
      res.status(StatusCode.Ok).end();
    });

    const rawBody = JSON.stringify({});
    await request(app)
      .post('/webhooks1')
      .set(
        headers({
          topic: 'PRODUCTS_CREATE',
          hmac: hmac(shopify.config.apiSecretKey, rawBody),
        }),
      )
      .send(rawBody)
      .expect(200);

    expect(handler1.callback).toHaveBeenCalled();
    expect(handler2.callback).not.toHaveBeenCalled();
  });

  it('fails to register multiple EventBridge handlers for the same topic', async () => {
    const handler1 = EVENT_BRIDGE_HANDLER;
    const handler2 = EVENT_BRIDGE_HANDLER;

    shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler1});

    expect(() => {
      shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler2});
    }).toThrowError(InvalidDeliveryMethodError);
  });

  it('fails to register multiple PubSub handlers for the same topic', async () => {
    const handler1 = PUB_SUB_HANDLER;
    const handler2 = PUB_SUB_HANDLER;

    shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler1});

    expect(() => {
      shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler2});
    }).toThrowError(InvalidDeliveryMethodError);
  });
});

describe('dual webhook registry instances', () => {
  let shopify2: Shopify;
  let handler1: HttpWebhookHandler;
  let handler2: HttpWebhookHandler;

  beforeEach(async () => {
    handler1 = {...HTTP_HANDLER, callbackUrl: '/webhooks', callback: jest.fn()};
    handler2 = {
      ...HTTP_HANDLER,
      callbackUrl: '/webhooks2',
      callback: jest.fn(),
    };

    shopify.config.apiSecretKey = 'kitties are cute';
    shopify.config.isEmbeddedApp = true;

    shopify2 = shopifyApi(getNewTestConfig());
    shopify2.config.apiSecretKey = 'dogs are cute too';
    shopify2.config.isEmbeddedApp = true;
  });

  it('adds different handlers for different topics to each registry', async () => {
    shopify.webhooks.addHandlers({PRODUCTS: handler1});
    shopify2.webhooks.addHandlers({PRODUCTS_CREATE: handler2});

    expect(shopify.webhooks.getTopicsAdded()).toStrictEqual(['PRODUCTS']);
    expect(shopify.webhooks.getHandlers('PRODUCTS')).toStrictEqual([handler1]);
    expect(shopify.webhooks.getHandlers('PRODUCTS_CREATE')).toEqual([]);
    expect(shopify2.webhooks.getTopicsAdded()).toStrictEqual([
      'PRODUCTS_CREATE',
    ]);
    expect(shopify2.webhooks.getHandlers('PRODUCTS_CREATE')).toStrictEqual([
      handler2,
    ]);
    expect(shopify2.webhooks.getHandlers('PRODUCTS')).toEqual([]);
  });

  it('adds different handlers for same topic to each registry', async () => {
    shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler1});
    shopify2.webhooks.addHandlers({PRODUCTS_CREATE: handler2});

    expect(shopify.webhooks.getTopicsAdded()).toStrictEqual([
      'PRODUCTS_CREATE',
    ]);
    expect(shopify.webhooks.getHandlers('PRODUCTS_CREATE')).toStrictEqual([
      handler1,
    ]);
    expect(shopify2.webhooks.getTopicsAdded()).toStrictEqual([
      'PRODUCTS_CREATE',
    ]);
    expect(shopify2.webhooks.getHandlers('PRODUCTS_CREATE')).toStrictEqual([
      handler2,
    ]);
  });

  const rawBody = '{"foo": "bar"}';
  const app = getTestExpressApp();
  app.post('/webhooks', async (req, res) => {
    let errorThrown = false;
    let statusCode = StatusCode.Ok;
    try {
      await shopify.webhooks.process({
        rawBody: (req as any).rawBody,
        rawRequest: req,
        rawResponse: res,
      });
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(InvalidWebhookError);
      statusCode = error.response.statusCode;
    }
    res.status(statusCode).json({errorThrown});
  });
  app.post('/webhooks2', async (req, res) => {
    let errorThrown = false;
    let statusCode = StatusCode.Ok;
    try {
      await shopify2.webhooks.process({
        rawBody: (req as any).rawBody,
        rawRequest: req,
        rawResponse: res,
      });
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(InvalidWebhookError);
      statusCode = error.response.statusCode;
    }
    res.status(statusCode).json({errorThrown});
  });

  it('can fire handlers from different instances', async () => {
    shopify.webhooks.addHandlers({PRODUCTS_CREATE: handler1});
    shopify2.webhooks.addHandlers({PRODUCTS_CREATE: handler2});

    let response = await request(app)
      .post('/webhooks')
      .set(
        headers({
          topic: 'PRODUCTS_CREATE',
          hmac: hmac(shopify.config.apiSecretKey, rawBody),
        }),
      )
      .send(rawBody);

    expect(response.status).toEqual(StatusCode.Ok);
    expect(response.body.errorThrown).toBeFalsy();
    expect(handler1.callback).toHaveBeenCalled();
    expect(handler2.callback).not.toHaveBeenCalled();

    (handler1.callback as jest.Mock).mockClear();
    (handler2.callback as jest.Mock).mockClear();

    response = await request(app)
      .post('/webhooks2')
      .set(
        headers({
          topic: 'PRODUCTS_CREATE',
          hmac: hmac(shopify2.config.apiSecretKey, rawBody),
        }),
      )
      .send(rawBody);

    expect(response.status).toEqual(StatusCode.Ok);
    expect(response.body.errorThrown).toBeFalsy();
    expect(handler1.callback).not.toHaveBeenCalled();
    expect(handler2.callback).toHaveBeenCalled();
  });
});

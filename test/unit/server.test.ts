import assert from 'assert';
import config, {
} from './config.ts';

import {
    ById,
    clone,
    randomCouchString
} from '../../plugins/core/index.mjs';
import type {
    startRxServer as startRxServerType
} from '../../plugins/server/index.mjs';
import {
    replicateServer
} from '../../plugins/replication-server/index.mjs';
import * as humansCollection from './../helper/humans-collection.ts';
import { nextPort } from '../helper/port-manager.ts';
import { ensureReplicationHasNoErrors } from '../helper/test-util.ts';
import * as schemas from '../helper/schemas.ts';
import { waitUntil } from 'async-test-util';
import * as schemaObjects from '../helper/schema-objects.ts';
import EventSource from 'eventsource';
import type { IncomingHttpHeaders } from 'node:http';

const urlSubPaths = ['pull', 'push', 'pullStream'];

config.parallel('server.test.ts', () => {
    if (
        !config.platform.isNode() &&
        !config.isBun
    ) {
        return;
    }

    const authenticationHandler = (requestHeaders: IncomingHttpHeaders) => {

        console.log('auth:');
        console.dir(requestHeaders);

        if (requestHeaders.authorization === 'is-valid') {
            console.log('auth valid!');
            return { validUntil: Date.now() + 100000, data: {} };
        } else {
            console.log('auth NOT valid!');
            throw new Error('auth not valid');
        }
    };
    const headers = {
        Authorization: 'is-valid'
    };


    let startRxServer: typeof startRxServerType;
    describe('init', () => {
        it('load server plugin', async () => {
            const serverPlugin = await import('../../plugins/server/index.mjs');
            startRxServer = serverPlugin.startRxServer;
        });
    });
    describe('basics', () => {
        it('should start end stop the server', async () => {
            const port = await nextPort();
            const col = await humansCollection.create(0);
            const server = await startRxServer({
                database: col.database,
                authenticationHandler,
                port,
                hostname: 'localhost'
            });
            await server.addReplicationEndpoint({
                collection: col
            });
            await col.database.destroy();
        });
    });
    describe('replication endoint', () => {
        describe('basics', () => {

            it('should be able to reach the endpoint', async function () {
                this.timeout(100000);
                const col = await humansCollection.create(1);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authenticationHandler,
                    port,
                    hostname: 'localhost'
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath + '/pull';
                const response = await fetch(url, {
                    headers
                });
                const data = await response.json();
                assert.ok(data.documents[0]);
                assert.ok(data.checkpoint);
                await col.database.destroy();
            });
        });
        describe('replication', () => {

            it('should replicate all data in both directions', async function () {
                const col = await humansCollection.create(5);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authenticationHandler,
                    port,
                    hostname: 'localhost'
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const clientCol = await humansCollection.create(5);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                ensureReplicationHasNoErrors(replicationState);

                await replicationState.awaitInSync();

                const docsB = await clientCol.find().exec();
                assert.strictEqual(docsB.length, 10);

                const docsA = await col.find().exec();
                assert.strictEqual(docsA.length, 10);

                await col.database.destroy();
                await clientCol.database.destroy();
            });
            it('should give a 426 error on outdated versions', async () => {
                const newestSchema = clone(schemas.human);
                newestSchema.version = 1;
                const col = await humansCollection.createBySchema(newestSchema, undefined, undefined, { 1: d => d });
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authenticationHandler,
                    port,
                    hostname: 'localhost'
                });
                await server.addReplicationEndpoint({
                    collection: col
                });

                // check with plain requests
                for (const path of urlSubPaths) {
                    const response = await fetch('http://localhost:' + port + '/replication/human/0/' + path);
                    assert.strictEqual(response.status, 426);
                }

                // check with replication
                const clientCol = await humansCollection.createBySchema(schemas.human);
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url: 'http://localhost:' + port + '/replication/human/0',
                    headers,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });

                const errors: any[] = [];
                replicationState.error$.subscribe(err => errors.push(err));

                let emittedOutdated = false;
                replicationState.outdatedClient$.subscribe(() => emittedOutdated = true);
                await waitUntil(() => emittedOutdated);


                await waitUntil(() => errors.length > 0);
                const firstError = errors[0];
                assert.strictEqual(firstError.code, 'RC_PULL');

                col.database.destroy();
                clientCol.database.destroy();
            });
            it('must replicate ongoing changes', async () => {
                const col = await humansCollection.create(5);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authenticationHandler,
                    port,
                    hostname: 'localhost'
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const clientCol = await humansCollection.create(5);
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers,
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource
                });
                ensureReplicationHasNoErrors(replicationState);
                await replicationState.awaitInSync();

                // server to client
                await col.insert(schemaObjects.human());
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 11;
                });

                // client to server
                await clientCol.insert(schemaObjects.human());
                await waitUntil(async () => {
                    const docs = await col.find().exec();
                    return docs.length === 12;
                });

                // do not miss updates when connection is dropped
                server.httpServer.closeAllConnections();
                await col.insert(schemaObjects.human());
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 13;
                });

                col.database.destroy();
                clientCol.database.destroy();
            });
        });
        describe('authentication', () => {
            it('should drop non authenticated clients', async () => {
                const col = await humansCollection.create(1);
                const port = await nextPort();
                const server = await startRxServer({
                    database: col.database,
                    authenticationHandler,
                    port,
                    hostname: 'localhost'
                });
                const endpoint = await server.addReplicationEndpoint({
                    collection: col
                });
                const url = 'http://localhost:' + port + '/' + endpoint.urlPath;

                // check with plain requests
                for (const path of urlSubPaths) {
                    const response = await fetch(url + '/' + path);
                    assert.equal(response.status, 401);
                    const data = await response.json();
                    console.dir(data);
                }

                // check with replication
                const clientCol = await humansCollection.create(1);
                const replicationState = await replicateServer({
                    collection: clientCol,
                    replicationIdentifier: randomCouchString(10),
                    url,
                    headers: {},
                    live: true,
                    push: {},
                    pull: {},
                    eventSource: EventSource,
                    retryTime: 100
                });

                let emittedUnauthorized = false;
                replicationState.unauthorized$.subscribe(() => emittedUnauthorized = true);
                await waitUntil(() => emittedUnauthorized === true);

                // setting correct headers afterwards should make the replication work again
                replicationState.headers = headers;
                await replicationState.awaitInSync();

                await col.insert(schemaObjects.human('after-correct-headers'));
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 3;
                });

                await replicationState.awaitInSync();
                await col.insert(schemaObjects.human('after-correct-headers-ongoing'));
                await waitUntil(async () => {
                    const docs = await clientCol.find().exec();
                    return docs.length === 4;
                });

                col.database.destroy();
                clientCol.database.destroy();
            });
        });
    });

});

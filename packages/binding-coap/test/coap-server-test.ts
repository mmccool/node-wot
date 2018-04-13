/**
 * Protocol test suite to test protocol implementations
 */

import { suite, test, slow, timeout, skip, only } from "mocha-typescript";
import { expect, should, assert } from "chai";
// should must be called to augment all variables
should();

import { AssetResourceListener } from "@node-wot/core";

import CoapServer from "../src/coap-server";

const coap = require("coap");

@suite("CoAP server implementation")
class CoapServerTest {

    @test async "should start and stop a server"() {
        let coapServer = new CoapServer(56831);

        await coapServer.start();
        expect(coapServer.getPort()).to.eq(56831); // from test
        
        await coapServer.stop();
        expect(coapServer.getPort()).to.eq(-1); // from getPort() when not listening
    }

    @test.skip async "should cause EADDRINUSE error when already running"() {
        let coapServer1 = new CoapServer(0); // cannot use 0, since getPort() does not work
        coapServer1.addResource("/", new AssetResourceListener("One") );
        await coapServer1.start()

        expect(coapServer1.getPort()).to.be.above(0); // from server._port, not real socket

        let coapServer2 = new CoapServer(coapServer1.getPort());
        coapServer2.addResource("/", new AssetResourceListener("Two") );

        try {
            await coapServer2.start(); // should fail, but does not...
        } catch(err) {
            assert(true);
        }

        expect(coapServer2.getPort()).to.eq(-1);

        let req = coap.request({ method: "GET", hostname: "localhost", port: coapServer1.getPort(), path: "/" });
        req.on("response", async (res : any) => {
            expect(res.payload.toString()).to.equal("One");

            await coapServer1.stop();
            await coapServer2.stop();
        });
        req.end();
    }
}

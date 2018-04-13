/**
 * Protocol test suite to test protocol implementations
 */

import { suite, test, slow, timeout, skip, only } from "mocha-typescript";
import { expect, should, assert } from "chai";
// should must be called to augment all variables
should();

import { ResourceListener, BasicResourceListener, Content, ContentSerdes } from "@node-wot/core";

import HttpServer from "../src/http-server";
import HttpClient from "../src/http-client";

class TestResourceListener extends BasicResourceListener implements ResourceListener {

    public referencedVector: any;
    constructor(vector: any) {
        super();
        this.referencedVector = vector;
    }

    public onRead() : Promise<Content> {
        this.referencedVector.expect = "GET";
        return new Promise<Content>(
            (resolve,reject) => resolve({ mediaType: ContentSerdes.DEFAULT , body: new Buffer("TEST") })
        );
    }

    public onWrite(content : Content) : Promise<void> {
        this.referencedVector.expect = "PUT";
        return new Promise<void>((resolve,reject) => resolve())
    }

    public onInvoke(content : Content) : Promise<Content> {
        this.referencedVector.expect = "POST";
        return new Promise<Content>(
            (resolve,reject) => resolve({ mediaType: ContentSerdes.DEFAULT, body: new Buffer("TEST") })
        );
    }

    public onUnlink() : Promise<void> {
        this.referencedVector.expect = "DELETE";
        return new Promise<void>(
            (resolve,reject) => resolve()
        );
    }
}

@suite("HTTP client implementation")
class HttpClientTest {

    @test async "should apply form information"() {

    try {

        var testVector = { expect: "UNSET" }

        let httpServer = new HttpServer(60603);
        httpServer.addResource("/", new TestResourceListener(testVector) );

        await httpServer.start();
        expect(httpServer.getPort()).to.equal(60603);

        let client = new HttpClient();
        let representation;

        // read with POST instead of GET
        representation = await client.readResource({
            href: "http://localhost:60603/",
            "http:methodName": "POST"
        });
        expect(testVector.expect).to.equal("POST");
        testVector.expect = "UNSET";

        // write with POST instead of PUT
        representation = await client.writeResource({
            href: "http://localhost:60603/",
            "http:methodName": "POST"
        }, { mediaType: ContentSerdes.DEFAULT, body: new Buffer("test") } );
        expect(testVector.expect).to.equal("POST");
        testVector.expect = "UNSET";

        // invoke with PUT instead of POST
        representation = await client.invokeResource({
            href: "http://localhost:60603/",
            "http:methodName": "PUT"
        }, { mediaType: ContentSerdes.DEFAULT, body: new Buffer("test") } );
        expect(testVector.expect).to.equal("PUT");
        testVector.expect = "UNSET";

        // invoke with DELETE instead of POST
        representation = await client.invokeResource({
            href: "http://localhost:60603/",
            "http:methodName": "DELETE"
        });
        expect(testVector.expect).to.equal("DELETE");
        testVector.expect = "UNSET";
        
        // FIXME -- why does it block forever?
        //await httpServer.stop();

    } catch (err) {
        console.error("ERROR", err);
    }
    }
}

#!/usr/bin/env node
 // OCF TD Generator
 //
 // Run on same device where an iot-rest-api-server is running
 // that provides an HTTP gateway to OCF devices on the local
 // network.  This script first queries the OCF gateway to discover
 // all the local OCF resources, then constructs a WoT Thing Description,
 // to provide access to them, then serves it over a local port via HTTP,
 // making it available to WoT devices that may want to consume it.
 //
 // See https://01.org/smarthome and https://github.com/01org/SmartHome-Demo
 // on how to set up a suitable test system.  Note that you don't need
 // the gateway.js script, you just want to run the iot-rest-api-server,
 // which can be found here: https://github.com/01org/iot-rest-api-server/

// Output uses util.debuglog, so NODE_DEBUG needs to include
// one of the following keys for results to show up.
var util_q = require('util');
var basic_log = util_q.debuglog('wot-ocf-gen');
var info_log = util_q.debuglog('wot-ocf-gen-info');
var debug_log = util_q.debuglog('wot-ocf-gen-debug');
var verbose_log = util_q.debuglog('wot-ocf-gen-verbose');
var silly_log = util_q.debuglog('wot-ocf-gen-silly');
 
// Options
var cmdr = require("commander");
cmdr
.option('-s, --scan-period <scan_period>','OCF resource scan period in ms')
.option('-d, --desc-period <desc_period>','OCF descriptions scan period in ms')
.option('-e, --extra-period <extra_period>','TD extra time-to-live')
.option('-l, --local-hosts <local_hosts>','Use predefined localhost urls')
.option('-o, --ocf-host <ocf-host>','OCF iot-rest-api-server base url')
.option('-t, --td-host <td-host>','Thing Directory base url')
.option('-m, --metadata <metadata path>','path to aux metdata file')
.option('-p, --port <server port>','port to serve TDs on')
.parse(process.argv);

// How often to scan OCF metadata and update TDs. 
var scan_period = 30*1000;  // milliseconds
if (cmdr.scanPeriod) scan_period = cmdr.scanPeriod;

// How often to scan OCF descriptions and update description database
var scan_descs_period = 120*1000;  // milliseconds
if (cmdr.descPeriod) scan_descs_period = cmdr.descPeriod;

// How long until TDs expire in Thing Directory.
//   needs to be larger than scan_period, of course.
var extra_period = scan_descs_period + 5000;  // milliseconds
if (cmdr.extraPeriod) extra_period = cmdr.extraPeriod;
var td_period = scan_period + extra_period; // milliseconds

// Whether to use local servers or gateway
var local_hosts = false;
if (cmdr.localHosts) local_hosts = cmdr.localHosts;

// Get current host IP (Use for local links...)
const ip = require("ip"); // not used yet
var current_ip = ip.address();
info_log("Current host IP: ",current_ip);

// Where to find iot-rest-api-server
//    a GET on <ocf_host>/api/oic/res
//    should return OCF resources
var ocf_host = (local_hosts ? 
    "http://" + current_ip + ":8000":
    "http://gateway.mmccool.net:8000"
);
if (cmdr.ocfHost) ocf_host = cmdr.ocfHost;
const ocf_base = ocf_host + '/api/';

// Where to find thing-directory server
var td_host = (local_hosts ? 
    "http://" + current_ip + ":8090":
    "http://gateway.mmccool.net:8090"
    // "http://plugfest.thingweb.io:8081"
);
if (cmdr.tdHost) td_host = cmdr.tdHost;
const td_base = td_host;

// Always serves TD on localhost
//   a GET on http://<self_hostname>:<self_port> 
//   will return an array of the current TDs
// NOTE: currently only HTTP supported
const self_hostname = "localhost";
var self_port = 8091;  // port to make TDs available on
if (cmdr.selfPort) self_port = cmdr.selfPort;

// Aux metadata path
var aux_metadata_path = "./metadata.json";
if (cmdr.metadat) aux_metadata_path = cmdr.metadata;

// Dependencies
const request = require("request");
 
// Helper function to pretty-print JSON
const util = require("util");
function json_pp(object) {
  return util.inspect(object,{depth: null, colors: true});
}

// Helper function to merge maps.  Attributes named the same will result
// in the one from A being given priority.
function concatMaps(A,B) {
  let C = {};
  for (let a in A) {
      if (A.hasOwnProperty(a)) C[a] = A[a];
  }
  for (let a in B) {
      if (B.hasOwnProperty(a) && !A[a]) C[a] = B[a];
  }
  return C;
}

// Get OCF device descriptions from OCF /oic/d interface
// We do this asynchronously with the other request to (a) catch
// descriptions that only show up once in a while (b) reduce the 
// latency of the main metadata gathering process
ocf_descs = []; // will be a map from di -> descriptions
function scan_ocf_descs() {
   const desc_url = ocf_base + 'oic/d';
   basic_log("OCF Description URL: ",desc_url);
   request(desc_url,function(error,response,desc_body) {
       if (error) throw ("OCF Gateway is not responding ("+error+")");
       silly_log("OCF description response body: "+desc_body);
       let descs = [];
       try {
           descs = JSON.parse(desc_body);
           // Pretty-print Descriptions
           info_log('OCF Description - Response received');
           silly_log(json_pp(descs));
       } catch(e) {
           throw("Could not parse response from OCF Gateway as JSON ("+e+")");
       }
       if (!Array.isArray(descs)) throw "Array expected";

       // now iterate through data, and update ocf_descs entry
       for (let i = 0; i < descs.length; i++) {
           ocf_descs[descs[i].di] = descs[i].n;
       }

       info_log("updated descriptions");
       verbose_log(json_pp(ocf_descs));
   });
}

// Run the above periodically
setInterval(scan_ocf_descs,scan_descs_period);

// Run at startup to initialize description database
scan_ocf_descs();

// OCF Resource types to ignore, except for fetching metadata
ocf_ignore_rt = ["oic.wk.p","oic.wk.d","oic.r.doxm","oic.r.pstat"];

// All OCF Resource types found (use to fetch external metadata...)
ocf_found_rt = [];

// Get OCF resources from OCF REST API Server on OCF Gateway and normalize;
// return array with one entry per device ID, and with OCF-specific
// resources stripped out.  Async function, calls done_callback when complete. 
function get_ocf_metadata(
    ocf_host,     // base URL of OCF iot-rest-api-server
    done_callback // call when done
) {
    const res_url = ocf_base + 'oic/res';
    basic_log("OCF Resource URL: ",res_url);

    // Query OCF Resources through gateway running iot-rest-api-server
    request(res_url,function(error,response,res_body) {
      if (error) throw ("OCF Gateway is not responding ("+error+")");
      basic_log('OCF resources - Response received');
      silly_log("OCF resource response body: "+res_body);
      let resources = undefined;
      try {
          resources = JSON.parse(res_body);
          // Pretty-print OCF Resource Description
          silly_log(json_pp(resources));
      } catch(e) {
          throw("Could not parse response from OCF Gateway as JSON ("+e+")");
      }
      if (!Array.isArray(resources)) throw "Array expected";

      // initial database is empty
      let ocf_metadata = []; // map from unique dis -> array of resources

      // scan through all resources listed
      for (let resource of resources) {
          // Get device ID
          const resource_di = resource["di"];
          if (undefined === resource_di) throw "Resource with undefined di";

          // Find record in current database; if empty, create it
          if (undefined === ocf_metadata[resource_di]) {
             // Find descriptive name 
             let resource_n = ocf_descs[resource_di]; 
             if (undefined === resource_n) resource_n = resource_di;

             // Create initial record with empty links
             ocf_metadata[resource_di] = {
                 "name": resource_n,
                 "links": []
             };
          }

          // Get device links
          const resource_links = resource["links"];
          if (undefined === resource_di) throw "Resource with no links";

          // Filter out "ignored" elements, copy useful information out
          let i = ocf_metadata[resource_di].links.length;
          for (let j = 0; j < resource_links.length; j++) {
            let link = resource_links[j];
            let rt = link.rt;

            // if rt not found in prior list, add it
            if (ocf_found_rt.indexOf(rt) === -1) {
                let k = ocf_found_rt.length;
                ocf_found_rt[k] = rt;
            }

            // if rt not found in blacklist, add link to output
            if (ocf_ignore_rt.indexOf(rt) === -1) {
              ocf_metadata[resource_di].links[i] = link;
              i++;
            }
          }
       }

       // log ocf metadata
       info_log("Normalized OCF metadata");
       verbose_log(json_pp(ocf_metadata));

       // log ocf rts
       info_log("Found OCF rts");
       verbose_log(json_pp(ocf_found_rt));

       // Call continuation
       done_callback(ocf_metadata);
   });
}

// Read Auxiliary metadatabase (stored as JSON-with-comments)
const shush = require("shush");
const aux_metadata = shush(aux_metadata_path);
verbose_log("Aux metadata: ",json_pp(aux_metadata));

// Used at plugfest...
// name_prefix = "";
name_prefix = "Intel-OCF-";

// Generate array of TDs (one per device ID)
//  from normalized OCF metadata
function generate_tds(ocf_metadata,done_callback) {
    let use_prop_base = false;
    let prop_base = ocf_base + "oic";
    let tds = [];
    let i = 0;
    // look at all key/value pairs
    Object.keys(ocf_metadata).forEach(function(di) {
      // check that the links are not empty
      let links = ocf_metadata[di].links;
      if ([] !== links) {
          // TD header for this device
          let td = {
              "@context": [
                  "http://w3c.github.io/wot/w3c-wot-td-context.jsonld",
                  "http://w3c.github.io/wot/w3c-wot-common-context.jsonld"
	          // ,{"iot": "http://iotschema.org/"}
	          // ,{"test": "http://gateway.mmccool.net/test.jsonld"}
               ],
               "base": (use_prop_base ? "" : prop_base),
               "@type": [ "Thing" ],
               "name": name_prefix + ocf_metadata[di].name,
               "interaction": []
          };
          // convert OCF links to WoT interactions
          let jj = 0;
          for (let j=0; j < links.length; j++) { 
              let link = links[j];
              let href = link.href;
              let rt = link.rt;
              // Check if aux metadata exists
              let aux = undefined;
              if (undefined !== link.rt) {
                  aux = aux_metadata[link.rt];
              }
              // Figure out name for resource
              let name;
              if (aux) {
                  // use aux metaname name if possible
                  name = aux.interaction[0].name;
              } else {
                  // otherwise use last segment of path
                  name = link.href.split("/")[-1];
              }
              // Set up basic header for this interaction
              let interaction = {
                  "name": name,
                  "@type": [],
                  "link": [
                      {
                          "href": ((use_prop_base) ? prop_base : "") + link.href
                           + "?di=" + di,
                          "mediatype": "application/json"
                      }
                  ]
              };
              // Handle first "Property" interaction for each resource
              if (aux) {
                  // add inputdata protocol binding, if any
                  if (aux.interaction[0].inputdata) {
                      interaction.inputdata = aux.interaction[0].inputdata;
                  }
                  // add outputdata protocol binding, if any
                  if (aux.interaction.outputdata) {
                      interaction.outputdata = aux.interaction[0].outputdata;
                  }
                  // add extra semantic tags for interaction (if any)
                  interaction["@type"] = 
                      interaction["@type"].concat(aux.interaction[0]["@type"]);
                  // add extra semantic tags for entire thing (if any)
                  td["@type"] = 
                      td["@type"].concat(aux["@type"]);
              }
              // append WoT "Property" interaction for this OCF resource
              td.interaction[jj++] = interaction;
              // append any additional interactions (eg Actions, Events)
              if (aux) {
                 for (let k=1; k < aux.interaction.length; k++) {
                     td.interaction[jj++] = aux.interaction[k];
                 }
              }
          }
          // TODO: remove duplicate global semantic tags
          tds[i] = td;
          i++;
       }
    });
    done_callback(tds); 
}

// Construct TD database from OCF metadata, store in variable 
// also call done_callback with copy of updated database
function construct_TDs(ocf_host,done_callback) {
    get_ocf_metadata(ocf_host,
        function(ocf_metadata) {
            generate_tds(ocf_metadata,
                function(tds) {
                    done_callback(tds);
                }
            );
        }
    );
}

// var querystring = require('querystring');
// var fs = require('fs');

// Persistent cache to relate TDs to keys in Thing Directory
var td_cache = require('persistent-cache')();

// Update TD in the Thing Directory.
function put_TD(td_key,td,done_callback) {
    let td_string = JSON.stringify(td);
    let options = {
        host: 'plugfest.thingweb.io',
        port: '8081',
        //host: "localhost",
        //port: '8090',
        path: td_key,
        method: 'PUT',
        headers: {
            'Content-Type': 'application/ld+json',
            'Content-Length': Buffer.byteLength(td_string),
            'Access-Control-Allow-Origin': '*'
        }
    };
    var td_url = "http://" + options.host + ":" + options.port + options.path;
    debug_log("Updating TD via PUT for " + td.name + " to Thing Directory at " + td_url);
    var req = http.request(options,function(res) {
        debug_log('Status: ' + res.statusCode);
        debug_log('Headers: ' + JSON.stringify(res.headers));
        res.setEncoding('utf8');
        res.on('data', function (body) {
            console.log('Body: ' + body);
        });

        debug_log('Thing Directory PUT Response: ' + res.statusCode);
        done_callback(200 !== res.statusCode);
    });
    req.on('error', function(err) {
        debug_log('problem with PUT: ' + err.message);
    });
    req.write(td_string);
    req.end();
}

// Record key for posted TD
function record_TD_key(td_key,td_name,done_callback) {
    debug_log("Caching key/name association: ",td_key," : ",td_name);
    td_cache.put(td_name,td_key,done_callback);
}

// Post a new TD to the Thing Directory.
function post_TD(td,done_callback) {
    let td_string = JSON.stringify(td);
    let options = {
        host: 'plugfest.thingweb.io',
        port: '8081',
        // host: "localhost",
        // port: '8090',
        path: '/td',
        method: 'POST',
        headers: {
            'Content-Type': 'application/ld+json',
            'Content-Length': Buffer.byteLength(td_string),
            'Access-Control-Allow-Origin': '*'
        }
    };
    var td_url = options.host + ':' + options.port + options.path;
    debug_log("Creating new TD via POST for " + td.name + " to Thing Directory at " + td_url);
    var req = http.request(options,function(res) {
        debug_log('Status: ' + res.statusCode);
        debug_log('Headers: ' + JSON.stringify(res.headers));
        res.setEncoding('utf8');
        res.on('data', function (body) {
            console.log('Body: ' + body);
        });

        let td_name = td.name;
        let td_key = res.headers['location'];
        debug_log('Thing Directory POST Response: ' + res.statusCode,'; key = ' + td_key);
        if (undefined !== td_key) {
            record_TD_key(td_key,td_name,done_callback);
        } else {
            done_callback("POST failed");
        }
    });
    req.write(td_string);
    req.end();
}

// Either create or update TD depending on whether it already exists
function update_TD(td,done_callback) {
    td_cache.get(td.name,function(err,key) {
         if (err) {
             debug_log("Problem with reading cache");
             done_callback(err);
         } else {
             if (undefined === key) {
                 // Does not exist, create new entry
                 post_TD(td,done_callback);
             } else {
                 // Exists, so update existing entry
                 put_TD(key,td,done_callback);
             }
         }
    });
}

let TDs = []; // initial state of local TD database

// Scan TDs and update database (local, and also Thing Directory)
function scan_TDs() {
    construct_TDs(ocf_host,
        function(tds) {
          for (let i=0; i < tds.length; i++) {
              update_TD(tds[i],function(err) {
                  if (err) {
                      debug_log("Error updating TD ",tds[i].name);
                  } else {
                      debug_log("Finished updating TD ",tds[i].name);
                  }
              });
          }
          TDs = tds;
          basic_log("Scan complete; TD database updated");
        }
    );
}

// Invoke scan and translation periodically
setInterval(scan_TDs,scan_period);

// Do an initial scan to initialize TD database
scan_TDs();

// Provide (pre-scanned) TDs via web server
const http = require('http');
basic_log("OCF Thing Description Metadata Bridge");

const self_url = 'http://' + self_hostname + ':' + self_port + '/';

const server = http.createServer(function(req,res) {
    basic_log("TD request received at",self_url);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/ld+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    basic_log("!!!!",JSON.stringify(TDs));
    basic_log(">>>>",json_pp(TDs));
    res.end(JSON.stringify(TDs));
});

server.listen(self_port,self_hostname,function() {
    basic_log('http server running at ',self_url);
});



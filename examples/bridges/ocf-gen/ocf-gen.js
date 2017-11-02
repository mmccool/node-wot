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
 
// Options

// How often to scan OCF metadata and update TDs. 
var scan_period = 10*1000;  // milliseconds

// How often to scan OCF descriptions and update description database
var scan_descs_period = 60*1000;  // milliseconds

// How long until TDs expire in Thing Directory.
//   needs to be larger than scan_period, of course.
var td_timeout = 15000; // milliseconds

// Output uses util.debuglog, so NODE_DEBUG needs to include
// one of the following keys for results to show up.
var util_q = require('util');
var basic_log = util_q.debuglog('wot-ocf-gen');
var info_log = util_q.debuglog('wot-ocf-gen-info');
var debug_log = util_q.debuglog('wot-ocf-gen-debug');
var verbose_log = util_q.debuglog('wot-ocf-gen-verbose');
var silly_log = util_q.debuglog('wot-ocf-gen-silly');

// Where to find iot-rest-api-server
//    a GET on http(s)://<ocf_host>:<ocf_port>/api/oic/res
//    should return OCF resources
const ocf_host = "gateway.mmccool.net";
const ocf_port = 8000; 
const ocf_protocol = "https"; // or https or http, depending
const ocf_base = ocf_protocol + '://' + ocf_host + ':' + ocf_port + '/api';

// Always serves TD on localhost
//   a GET on http://<td_host>:<td_port>/ 
//   (a) initiate a rescan and retranslate (b) will return the TD
// NOTE: currently only HTTP supported
const td_host = "localhost";
const td_port = 8091;  // port to make TD available on

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

// Read metadatabase (stored as JSON-with-comments)
const shush = require("shush");
const metadata = shush("metadata.json");

// Get current host IP (Use for local links...)
const ip = require("ip"); // not used yet
info_log("Current host IP: ",ip.address());


// Get OCF device descriptions from OCF /oic/d interface
// We do this asynchronously with the other request to (a) catch
// descriptions that only show up once in a while (b) reduce the 
// latency of the main metadata gathering process
ocf_descs = []; // will be a map from di -> descriptions
function scan_ocf_descs() {
   const desc_url = ocf_base + '/oic/d';
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
    ocf_protocol, // http or https
    ocf_host,     // hostname (or IP) of OCF iot-rest-api-server
    ocf_port,     // port used by iot-rest-api-server
    done_callback // call when done
) {
    const res_url = ocf_base + '/oic/res';
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

// Read Auxiliary metadatabase
// for each rt, list some extra, "inferred" data to include
// TODO: read this from an external JSON file/database
let aux_metadata = {
   "oic.r.led": {
       "@type": ["iot:Light","iot:BinarySwitch"],
       "interaction": {
           "name": "LED State",
           "@type": ["iot:SwitchStatus"],
           "outputdata": {
              "@type": ["iot:SwitchData"],
              "type": "boolean"
           },
       }
   }
};

// Used at plugfest...
// name_prefix = "";
name_prefix = "Intel-OCF-";

// Generate array of TDs (one per device ID)
//  from normalized OCF metadata
function generate_tds(ocf_metadata,done_callback) {
    let prop_base = ocf_base + "/oic";
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
                  "http://w3c.github.io/wot/w3c-wot-common-context.jsonld",
	          {"iot": "http://iotschema.org/"}
               ],
               "@type": [ "Thing" ],
               "name": name_prefix + ocf_metadata[di].name,
               "interaction": []
          };
          // convert OCF links to WoT properties
          for (let j=0; j < links.length; j++) { 
              let link = links[j];
              let href = link.href;
              let rt = link.rt;
              // Figure out name for property
              let aux = undefined;
              if (undefined !== link.rt) {
                  aux = aux_metadata[link.rt];
              }
              let name;
              if (aux) {
                  name = aux.interaction.name;
              } else {
                  name = link.href.split("/")[-1];
              }
              // Set up basic header
              let interaction = {
                  "name": name,
                  "@type": ["Property"],
                  "link": [
                      {
                          "href": prop_base + link.href
                           + "?di=" + di,
                          "mediatype": "application/json"
                      }
                  ]
              };
              if (aux) {
                  // add inputdata protocol binding, if any
                  if (aux.interaction.inputdata) {
                      interaction.inputdata = aux.interaction.inputdata;
                  }
                  // add outputdata protocol binding, if any
                  if (aux.interaction.outputdata) {
                      interaction.outputdata = aux.interaction.outputdata;
                  }
                  // add extra semantic tags for interaction (if any)
                  interaction["@type"] = 
                      interaction["@type"].concat(aux.interaction["@type"]);
                  // add extra semantic tags for entire thing (if any)
                  td["@type"] = 
                      td["@type"].concat(aux["@type"]);
              }
              // append WoT interaction for this OCF resource
              td.interaction[j] = interaction;
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
function construct_TDs(ocf_protocol,ocf_host,ocf_port,done_callback) {
    get_ocf_metadata(ocf_protocol,ocf_host,ocf_port,
        function(ocf_metadata) {
            generate_tds(ocf_metadata,
                function(tds) {
                    done_callback(tds);
                }
            );
        }
    );
}

// Scan TDs and update database.
// TODO: this should also send updates to the Thing Directory
let TDs = [];
function scan_TDs() {
    construct_TDs(ocf_protocol,ocf_host,ocf_port,
        function(tds) {
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

const td_url = 'http://' + td_host + ':' + td_port + '/';

const server = http.createServer(function(req,res) {
    basic_log("TD request received at",td_url);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/ld+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    basic_log("!!!!",JSON.stringify(TDs));
    basic_log(">>>>",json_pp(TDs));
    res.end(JSON.stringify(TDs));
});

server.listen(td_port,td_host,function() {
    basic_log('http server running at ',td_url);
});



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
var scan_period = 10000;  // milliseconds

// How often to scan OCF descriptions and update description database
var scan_descs_period = 30000;  // milliseconds

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

// OCF Resource types to ignore, except for fetching metadata
ocf_ignore_rt = ["oic.wk.p","oic.wk.d","oic.r.doxm","oic.r.pstat"];

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

       verbose_log("updated descriptions: ",ocf_descs);
   });
}

// Run the above periodically
setInterval(scan_ocf_descs,scan_descs_period);

// Run at startup to initialize description database
scan_ocf_descs();

// Get OCF resources from OCF REST API Server on OCF Gateway and normalize;
// return array with one entry per device ID, and with OCF-specific
// resources stripped out.  Async function, calls
// done_callback when complete. 
function get_ocf_metadata(
    ocf_protocol, // http or https
    ocf_host,     // hostname (or IP) of OCF iot-rest-api-server
    ocf_port,     // port used by iot-rest-api-server
    done_callback // call when done
) {
    debug_log("OCF Base: ",ocf_base);
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
      let ocf_metadata = [];

      // scan through all resources listed
      for (let resource of resources) {
          const resource_di = resource["di"];
          if (undefined === resource_di) throw "Resource with undefined di";

          // Find descriptive name of current device id
          let resource_n = ocf_descs[resource_di]; 
          if (undefined === resource_n) resource_n = resource_di;

          // Since di can have characters that won't work in a URL, like spaces, fix it up...
          let resource_name = resource_n;
          resource_name = resource_name.replace(/ /g,"");

          // Recover links
          const links = resource["links"];
          if (undefined === links) throw "Resource with undefined links";

          // Determine if any link is marked observable; if so, consider entire
          // resource observable
          let resource_observable = false;
          const link_p_bm_discoverable_mask = 1;
          const link_p_bm_observable_mask = 2;
          for (let link of links) {
              if (link["p"]["bm"] & link_p_bm_observable_mask) resource_observable = true;
          }

          // Create initial template for interaction
          debug_log("Creating resources for device ",resource_di);
          let interaction = {
              "@type": ["Property", "ocf:Resource"],
              "ocf:di": resource_di,
              "link": [] // initial state; will append to below
          };
          if (undefined !== resource_name) interaction["name"] = resource_name; // Mandatory in TD?
          if (undefined !== resource_n) interaction["ocf:n"] = resource_n; // Original "n" value from oic/d.n

          // Fill in link data for resources in interaction; look up extra metadata as necessary
          let resource_writable = false; // default
          let resource_inputdata = false;
          let resource_inputdata_properties = {}; // filled in with union of properties from all links
          let resource_outputdata = false;
          let resource_outputdata_properties = {}; // filled in with union of properties from all links

          // Scan through each link (in general, multiple are possible)
          for (let link of links) {
              let link_href = link["href"];
              // fix annoying inconsistency; sometime oic is included in path,
              // sometimes not...  Normalize by stripping any leading "/oic"
              // TODO: revisit after corrections to IoTivity/interpretation of spec
              link_href = link_href.replace(/^\/oic/,'');

              // get other values from OCF link structure
              // Following convert-scalars-to-arrays is to normalize IoTivity results
              const link_rt = Array.isArray(link["rt"]) ? link["rt"] : [link["rt"]]; // should be arrays
              const link_if = Array.isArray(link["if"]) ? link["if"] : [link["if"]]; // should be arrays
              const link_p = link["p"];
              const link_p_bm = link_p["bm"];
              const link_p_secure = link_p["secure"];

              // look up additional metadata from links
              let link_inputdata = false;
              let link_inputdata_template = [];
              let link_inputdata_template_type = [];

              let link_outputdata = false;
              let link_outputdata_template = [];
              let link_outputdata_template_type = [];

              // Scan through each rt (in general, multiple are possible)
              let link_ignore = true; // only remains true if all rts are ignorable
              for (let rt of link_rt) {
                  // Skip "ignorable" rts
                  basic_log(rt.toString()," in ",ocf_ignore_rt," = ",ocf_ignore_rt.indexOf(rt) != -1);
                  if (ocf_ignore_rt.indexOf(rt) != -1) continue;
                  link_ignore = false; 

                  // Gather metadata for other rts
                  const md = metadata[rt];
                  if (md) {
                      if (md["writable"]) resource_writable = true;
                      const md_inputdata = md["inputData"];
                      if (md_inputdata) {
                          link_inputdata = true;
                          link_inputdata_template_type.push(md_inputdata["templateType"]);
                          link_inputdata_template.push(md_inputdata["template"]);
                          resource_inputdata = true;
                          resource_inputdata_properties = concatMaps(
                              resource_inputdata_properties,
                              md_inputdata["properties"]
                          );
                      }
                      const md_outputdata = md["outputData"];
                      if (md_outputdata) {
                          link_outputdata = true;
                          link_outputdata_template_type.push(md_outputdata["templateType"]);
                          link_outputdata_template.push(md_outputdata["template"]);
                          resource_outputdata = true;
                          resource_outputdata_properties = concatMaps(
                              resource_outputdata_properties,
                              md_outputdata["properties"]
                          );
                      }
                  }
              }

              // TODO: since link_rt and link_if can be arrays, and in fact according the OCF spec
              // (but not IoTivity currently) MUST be arrays even if with only one element, then
              // different "views" may have different interaction models (eg writes not permitted) or
              // data models (different subsets of parameters). Should these be different links/resources
              // in the WoT TD, or do we need to deal with optional elements in the data models?

              // Rebuild URL, including di as a query parameter
              // TODO: this may or may not be a bug in IoTivity, check OCF spec to see if di is really necessary 
              // UPDATE: Checked OCF spec; it's not clear. Including the di does not seem to be wrong, at least.
              // NOTE: This does mean that if you want to add extra parameters, use & not ? before each
              const full_link_href = ocf_base + '/oic' + link_href + "?di=" + resource_di;

              if (!link_ignore) {
                  // Append new link
                  debug_log("Creating link ",link_href);
                  interaction.link.push({
                      "href": full_link_href,
                      "coap:rt": link_rt,
                      "coap:if": link_if,
                      "ocf:p": {
                          "ocf:bm": link_p_bm,
                          "ocf:secure": link_p_secure
                       },
                       // TODO: look up mediatype based on protocolContent metadata, protocol used for link
                       "mediaType": "application/json", 
                       "driver": "ocf" // for template conversion
                  });
                  let lastlink = interaction.link.length - 1;

                  // Add extra metadata for template to link just added
                  if (link_inputdata) {
                      interaction.link[lastlink]["inputData"] = {
                          "templateType": link_inputdata_template_type,
                          "template": link_inputdata_template
                      };
                  }
                  if (link_outputdata) {
                      interaction.link[lastlink]["outputData"] = {
                          "templateType": link_outputdata_template_type,
                          "template": link_outputdata_template
                      };
                  }
              }

	      // fill in extra data gathered from links
	      interaction["writable"] = resource_writable;
	      if (resource_inputdata) {
	          interaction["inputData"] = {
	              "valueType": {
		          "type": "object"  // always a generic object
		      },
  	              // merged map of all properties in all links..
		      "properties": resource_inputdata_properties
	          };
	      }
	      if (resource_outputdata) {
	          interaction["outputData"] = {
		      "valueType": {
		          "type": "object"  // always a generic object
	              },
		      // merged map of all properties in all links...
	              "properties": resource_outputdata_properties
		  };
              }

	      // Append interaction to normalized metadata
	      ocf_metadata.push(interaction);
          }
       }
       // Pretty-print ocf metadata
       info_log("Normalized OCF metadata");
       silly_log(json_pp(ocf_metadata));
       done_callback(ocf_metadata);
   });
}

// Generate array of TDs (one per device ID)
//  from normalized OCF metadata
function generate_tds(ocf_metadata,done_callback) {
    done_callback(ocf_metadata); // cheating, for now
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
    res.end(JSON.stringify(TDs));
});

server.listen(td_port,td_host,function() {
    basic_log('http server running at ',td_url);
});



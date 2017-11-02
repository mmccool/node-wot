 // OCF TD Generator
 //
 // Run on same device where an iot-rest-api-server is running
 // that provides an HTTP gateway to OCF devices on the local
 // network.  This script first queries the OCF gateway to discover
 // all the local OCF resources, then constructs a WoT Thing Description,
 // to provide access to them, then serves it over a local port via HTTP,
 // making it avail to WoT devices that may want to consume it.
 //
 // See https://01.org/smarthome and https://github.com/01org/SmartHome-Demo
 // on how to set up a suitable test system.  Note that you don't need
 // the gateway.js script, you just want to run the iot-rest-api-server,
 // which can be found here: https://github.com/01org/iot-rest-api-server/
 
// Options
const use_local_host = false;

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

// Get current host IP
const ip = require("ip");
const cur_host = ip.address();
console.log("current host: ",cur_host);
const use_cur_host = !use_local_host;

// Ports to serve TD on; a GET on http://<td_host>:<td_port>/ should return the TD
const td_host = (use_cur_host ? cur_host : "127.0.0.1");
const td_port = 8091;

// Host/Port that OCF gateway/bridge (eg iot-rest-api-server) is on; 
// a GET on http://<ocf_host>:<ocf_port>/api/oic/res should return OCF resources
const ocf_host = use_cur_host ? cur_host : "127.0.0.1";
const ocf_port = 8000;

// Verbosity level (0 is quiet, 1 some messages, 2 more messages, pretty-print data)
const verbose = 2;

// Get OCF resources from OCF REST API Server on OCF Gateway, Generate TD
function generate_td(ocf_host,ocf_port,td_host,td_port,done_callback) {
    // TODO: assumes HTTP only... but COAP also possible, as well as multiple host IPs
    const ocf_base = 'http://' + ocf_host + ':' + ocf_port + '/api';
    if (verbose) console.log("OCF Base: ",ocf_base);
    const td_base = 'http://' + td_host + ':' + td_port;
    if (verbose) console.log("TD Base: ",td_base);
    const res_url = ocf_base + '/oic/res';
    if (verbose) console.log("OCF Resource URL: ",res_url);
    request(res_url,function(error,response,res_body) {
      if (error) throw ("OCF Gateway is not responding ("+error+")");
      if (verbose > 1) console.log("OCF resource response body: "+res_body);
      let resources = undefined;
      try {
          resources = JSON.parse(res_body);
          if (verbose > 1) {
              // Pretty-print OCF Resource Description
              console.log('OCF Resource - Response');
              console.log(json_pp(resources));
          }
      } catch(e) {
          throw("Could not parse response from OCF Gateway as JSON ("+e+")");
      }
      if (!Array.isArray(resources)) throw "Array expected";

      // Now also try to get device descriptions
      const des_url = ocf_base + '/oic/d';
      if (verbose) console.log("OCF Description URL: ",des_url);
      request(des_url,function(error,response,des_body) {
          if (error) throw ("OCF Gateway is not responding ("+error+")");
          if (verbose > 1) console.log("OCF description response body: "+des_body);

          let descriptions = undefined;
          try {
              descriptions = JSON.parse(des_body);
              if (verbose > 1) {
                  // Pretty-print Descriptions
                  console.log('OCF Description - Response');
                  console.log(json_pp(descriptions));
              }
          } catch(e) {
              throw("Could not parse response from OCF Gateway as JSON ("+e+")");
          }
          if (!Array.isArray(descriptions)) throw "Array expected";

          let td = {
              "name": "ocf",
              "@context": ["http://w3c.github.io/wot/w3c-wot-td-context.jsonld",
                           "http://w3c.github.io/wot/w3c-wot-common-context.jsonld",
                           "http://w3c.github.io/wot/w3c-wot-coap-context.jsonld",
                           "http://w3c.github.io/wot/w3c-wot-ocf-context.jsonld"],
              "@type": [ "Thing", "ocf:Devices" ],
              "interaction": []
          };
          for (let resource of resources) {
              const resource_di = resource["di"];
              if (undefined === resource_di) throw "Resource with undefined di";

              // Find descriptive name of current device id
              let resource_n = resource_di; // if no descriptive name, will use di
              let resource_icv = undefined;
              for (let description of descriptions) {
                  if (description["di"] === resource_di) {
                      if (undefined !== description["n"]) resource_n = description["n"];
                      resource_icv = description["icv"];
                  }
              }
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

              // Create initial template for Property interaction 
              if (verbose > 1) console.log("creating resources for device ",resource_di);
              let interaction = {
                "@type": ["Property", "ocf:Resource"],
                "ocf:di": resource_di,
                "link": [] // initial state; will append to below
              };
              if (undefined !== resource_name) interaction["name"] = resource_name; // Mandatory in TD?
              if (undefined !== resource_n) interaction["ocf:n"] = resource_n; // Original "n" value from oic/d.n
              if (undefined !== resource_icv) interaction["ocf:icv"] = resource_icv;

              // Fill in link data for resources in interaction; look up extra metadata as necessary
              let resource_writable = false; // default
              let resource_inputdata = false;
              let resource_inputdata_properties = {}; // filled in with union of properties from all links
              let resource_outputdata = false;
              let resource_outputdata_properties = {}; // filled in with union of properties from all links
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
                  for (let rt of link_rt) {
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

                  // Append new link
                  if (verbose > 1) console.log("creating link ",link_href);
                  interaction.link.push({
                    "href": full_link_href,
                    "coap:rt": link_rt,
                    "coap:if": link_if,
                    "ocf:p": {
                       "ocf:bm": link_p_bm,
                       "ocf:secure": link_p_secure
                    },
                    "mediaType": "application/json", // TODO: look up based on protocolContent metadata, protocol used for link
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

              // Append interaction to device
              td.interaction.push(interaction);
          }
          if (verbose > 1) {
              // Pretty-print TD
              console.log("Generated OCF TD:");
              console.log(json_pp(td));
          }
          done_callback(td);
       });
   });
}

// Construct TD, provide via web server
const http = require('http');
if (verbose) console.log("OCF Thing Description generation");
const td_url = 'http://' + td_host + ':' + td_port + '/';
const server = http.createServer(function(req,res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/ld+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    generate_td(ocf_host,ocf_port,td_host,td_port,function(td) {
        res.end(JSON.stringify(td));
        
        if (verbose) console.log("New TD generated; now available at: ",td_url);
    });
});
server.listen(td_port,td_host,function() {
    console.log('Server running at ',td_url);
});



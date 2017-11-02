 // OCF Bridge
 //
 // Run on same device where an iot-rest-api-server is running
 // that provides an HTTP gateway to OCF devices on the local
 // network.  This script first queries the OCF gateway to discover
 // all the local OCF resources, then constructs a WoT Thing
 // to provide access to them.
 //
 // See https://01.org/smarthome and https://github.com/01org/SmartHome-Demo
 // on how to set up a suitable test system.  Note that you don't need
 // the gateway.js script, you just want to run the iot-rest-api-server,
 // which can be found here: https://github.com/01org/iot-rest-api-server/
 
var request = require("request");

// Helper function to pretty-print JSON
var util = require("util");
function json_pp(object) {
  return util.inspect(object,{depth: null, colors: true});
}

// Base URL for OCF resource directory
var ocf_base_url = 'http://localhost:8000';

// How often to query OCF resource directory and update Thing
var update_interval = 1000;

// Verbosity level (0 is quiet, 1 some messages, 2 more messages, pretty-print data)
var verbose = 2;

// Given OCF Resources, create WoT Thing
function create_bridge(resources,base_url) {
    if (!Array.isArray(resources)) throw "Array expected";
    WoT.createThing("ocfbridge").then(function(thing) {
        if (verbose) console.log("created " + thing.name);

	for (let resource of resources) {
            let resource_di = resource["di"];
            if (undefined === resource_di) throw "Resource with undefined di";
            let links = resource["links"];
            if (undefined === links) throw "Resource with undefined links";
	    for (let link of links) {
                let link_href = link["href"];
                let link_rt = link["rt"];
                let link_if = link["if"];
                let link_p = link["p"];
                let link_p_bm = link_p["bm"];
                let link_p_secure = link_p["secure"];

		let res_name = resource_di+link_href;
		let res_type = "object";
		 
		if (verbose > 1) console.log("created resource ",res_name);

                thing
		.addProperty(res_name, { type: res_type })
		//.onRetrieveProperty(...)
                .onUpdateProperty(res_name,
		    function(newValue, oldValue) {
                        console.log(oldValue + " -> " + newValue);
		    }
		);
            }
        }
         
	if (verbose > 1) {
	    // Pretty-print TD
            console.log("OCF Bridge TD:");
            console.log(json_pp(thing.getDescription()));
	}
    });
}

// Get OCF resources from OCF REST API Server on OCF Gateway
function update_thing(base_url) {
    let res_url = base_url + '/api/oic/res';
    request(res_url,function(error,response,body) {
      if (error) {
        throw ("OCF Gateway is not responding ("+error+")");
      }
      if (verbose > 1) console.log("OCF response body: "+body);
      let resources = undefined;
      try {
          resources = JSON.parse(body);
	  if (verbose > 1) {
	      // Pretty-print OCF Resource Description
	      console.log('OCF Resource Description');
	      console.log(json_pp(resources));
 	  }
      } catch(e) {
          throw("Could not parse response from OCF Gateway as JSON ("+e+")");
      }
      create_bridge(resources,base_url);
   });
}

// Initial Thing construction
if (verbose) console.log("Initial Thing construction");
update_thing(ocf_base_url);

// Periodically update Thing (in case OCF objects join or leave network)
//setInterval(function() {
//    if (verbose) console.log("Thing update");
//    update_thing(ocf_base_url);
//},update_interval);


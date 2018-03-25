"use strict"
// const WoT = require('wot');

// Helper function to pretty-print JSON
var util = require("util");
function json_pp(object) {
   return util.inspect(object,{depth: null, colors: true});
}

// Query Thing Directory to find a set of TDs with "Light" in them
const request = require('request');
function get_eps(callback) {
    request('http://plugfest.thingweb.io:8081/td-lookup/sem?text="Light"', { json: true }, 
    (err, res, body) => {
        if (err) { return console.log(err); }
        callback(Object.keys(body));
    });
}
 
// Get TD from OCF-TD generator, try to build interface
function toggle_lights(eps) {
  for (let i=0; i < eps.length; i++) {
      let base = "http://plugfest.thingweb.io:8081/td-lookup/ep?ep=";
      WoT.consume(base + eps[i]).then(thing => {
         // Get current status
         thing.getProperty("Switch Status").then( state => {
             console.log("LED State: " + state);
             // Toggle current status
             let new_state = !state;
             thing.setProperty("Switch Status",new_state).then( res => {
                 console.log("Set LED Result: " + res);
             }).catch(err => console.error(err));
         }).catch(err => console.error(err));
         // pretty-print TD
         console.log("TD:\n",json_pp(thing.getDescription()));
      }).catch(err => console.error(err));
  }
}

function test(eps) {
  console.log(eps);
}

// get_eps(test);

// Toggle all the Lights 
get_eps(toggle_lights);

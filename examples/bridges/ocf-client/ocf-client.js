"use strict"

// Helper function to pretty-print JSON
var util = require("util");
function json_pp(object) {
   return util.inspect(object,{depth: null, colors: true});
}

// Get TD from OCF-TD generator, try to build interface
WoT.consumeDescriptionUri("http://192.168.1.127:8091/").then(thing => {
    thing.getProperty("http://192.168.1.127:8000/api/oic/a/rgbled?di=b17ba04b-d383-4afd-818e-51646ea148c3").then( res => {
       console.log("READ RGB LED: " + res);
    }).catch(err => console.error(err));

    // pretty-print TD
    console.log("OCF-TD:\n",json_pp(thing.getDescription()));
}).catch(err => console.error(err));

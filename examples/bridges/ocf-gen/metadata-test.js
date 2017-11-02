 // Test Metadata Database
 //
 // To check at least that comment-stripping is working and 
 // JSON is well-formed.  Reads in, strips comments, parses
 // as JSON, then pretty-prints.
 //
 const verbose = 1;

// Helper function to pretty-print JSON
const util = require("util");
function json_pp(object) {
  return util.inspect(object,{depth: null, colors: true});
}

// Read metadatabase (stored as JSON-with-comments)
const shush = require('shush');
const metadata = shush('metadata.json');

// Pretty-print output
console.log("PRETTY:\n",json_pp(metadata));

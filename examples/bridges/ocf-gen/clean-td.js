#!/usr/bin/env node
 // Clean Up Thing Directory
 //
 // Delete all Thing Descriptions in a Thing Directory whose
 // names have a certain prefix.  This is to remove junk TDs
 // created during the plugfest ;).

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
.option('-n, --name_prefix <name_prefix>','Name prefix to look for')
.option('-h, --host <host>','host of Thing Directory')
.option('-p, --port <port>','port of Thing Directory')
.parse(process.argv);

// Name prefix to search for
var name_prefix = "Intel-OCF-";
if (cmdr.namePrefix) name_prefix = cmdr.namePrefix;

// Where to find thing-directory server
var host = "plugfest.thingweb.io";
if (cmdr.host) host = cmdr.host;
var port = "8081";
if (cmdr.port) port = cmdr.port;

// Helper function to pretty-print JSON
const util = require("util");
function json_pp(object) {
  return util.inspect(object,{depth: null, colors: true});
}

// Get TDs
const request = require("request");
function get_TDs(
   td_host,
   td_port,
   done_callback
) {
   const td_url = 'http://' + td_host + ':' + td_port + '/td';
   basic_log("Thing Directory URL: ",td_url);
   request(td_url,function(error,response,body) {
       if (error) throw ("Thing Directory is not responding ("+error+")");
       silly_log("Response body (raw): " + body);
       try {
           TDs = JSON.parse(body);
           // Pretty-print Descriptions
           info_log('Response received from Thing Directory');
           debug_log(json_pp(TDs));
       } catch(e) {
           throw("Could not parse response from Thing Directory as JSON ("+error+")");
       }
       done_callback(false,TDs);
   });
}

// Delete a specific TD
const http = require("http");
function delete_TD(
    td_host,
    td_port,
    td_key,
    done_callback
) {
    let options = {
        host: td_host,
        port: td_port,
        path: td_key,
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/ld+json',
            'Access-Control-Allow-Origin': '*'
        }
    };
    const td_url = 'http://' + td_host + ':' + td_port + td_key;
    console.log("Removing TD via DELETE for " + td_key + " from Thing Directory at " + td_url);
    var req = http.request(options,function(res) {
        debug_log('Status: ' + res.statusCode);
        debug_log('Headers: ' + JSON.stringify(res.headers));
        res.setEncoding('utf8');
        res.on('data', function (body) {
            console.log('Body: ' + body);
        });
        debug_log('Thing Directory DELETE Response: ' + res.statusCode);
        done_callback(false);
    });
    req.on('error', function(err) {
        debug_log('problem with DELETE: ' + err.message);
        done_callback(err.message);
    });
    req.end();
    done_callback(false);
}

// Look through TDs for names with the given prefix, make list of keys
function scan_TDs(prefix,TDs,done_callback) {
   var td_keys = [];
   Object.keys(TDs).forEach(function(td_key) {
     var td_name = TDs[td_key].name;
     if (td_name && td_name.startsWith(prefix)) {
       td_keys.push(td_key);
     }
   });
   done_callback(false,td_keys);
}

// Scan TDs, filter TDs to delete, then do deletions
function clean_TDs() {
    get_TDs(host,port,function(err,TDs) {
         if (err) {
             throw("Error getting TDs:",err);
         } else {
             scan_TDs(name_prefix,TDs,function(err,td_keys) {
                 if (err) {
                     throw("Error scanning TDs:",err);
                 } else {
                     console.log("Filtered keys: ",td_keys);
                     for (let i=0; i<td_keys.length; i++) {
                         let td_key = td_keys[i];
                         console.log("Delete "+td_key+" with name '"+TDs[td_key].name+"'");
                         delete_TD(host,port,td_key,function(err) {
                             if (err) {
                                 throw("Cannot delete TD with key ",td_key," err:",err);
                             } else {
                                 console.log("Deleted TD with key ",td_key);
                             }
                         });
                     }
                 }
             });
         }
    });
}

// Do it
clean_TDs();

console.log("--- MINI RENDERER START ---");
try {
    const fs = require('fs');
    console.log("Node Integration Test: require('fs') works");
    
    console.log("Attempting to require db.js...");
    const db = require('./db');
    console.log("SUCCESS: db.js required!");
    
    document.body.innerHTML = "<h1>DB Loaded!</h1>";
} catch (e) {
    console.error("CRITICAL ERROR IN RENDERER:", e);
    document.body.innerHTML = "<h1 style='color:red'>DB LOAD FAILED!</h1><pre>" + e.stack + "</pre>";
}
console.log("--- MINI RENDERER END ---");

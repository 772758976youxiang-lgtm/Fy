'use strict';
const fs=require('node:fs'),path=require('node:path');
const uiDirectory=fs.existsSync(path.join(__dirname,'ui'))?path.join(__dirname,'ui'):path.join(__dirname,'../luma');
module.exports={uiDirectory,C:require(path.join(uiDirectory,'core.js')),S:require(path.join(uiDirectory,'search.js'))};

const path = require('path');// need this to access file directory!

const Handling = require ('../models/sendingSever'); // Class

const sendingFile = new Handling (); //Global class - create new instance 



exports.sendHtml =(req, res, next) => {
    
    sendingFile.sendingHtml(req,res);

};

exports.sendAppaj = (req, res, next) => {

    sendingFile.sendingScript(req,res);
};


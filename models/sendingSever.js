const path = require('path');// need this to access file directory!

module.exports = class SendFile {

    sendingHtml(req,res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.sendFile(path.join(__dirname,'../','views','printLabel.html'));

    }

    sendingScript(req,res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.sendFile(path.join(__dirname,'../','views','ajax.js'));
    }



};

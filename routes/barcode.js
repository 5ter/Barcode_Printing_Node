const path = require('path'); // need this to access file directory!


const express = require('express');

const router = express.Router();

const htmlController = require ('../controllers/publish');

router.get('/',htmlController.sendHtml);

router.get('/ajax.js',htmlController.sendAppaj);


module.exports = router;
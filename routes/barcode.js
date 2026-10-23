const path = require('path'); // need this to access file directory!


const express = require('express');

const router = express.Router();

const htmlController = require ('../controllers/publish');

router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '..', 'views', 'workflowSelect.html'));
});

// Keep the existing Standard label page and print endpoint, but expose it as
// its own workflow so the Standard UI no longer needs an ARN tab.
router.get('/standard', htmlController.sendHtml);

router.get('/ajax.js',htmlController.sendAppaj);


module.exports = router;

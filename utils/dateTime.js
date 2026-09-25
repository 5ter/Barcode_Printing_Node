const moment = require('moment-timezone');
const logger = require('./logger'); 

/**
 * Calculates the current two-digit year and two-digit work week (YYWW).
 * @returns {string} The formatted YYWW string.
 */
function getYearAndWorkWeek() {
   
    const now = moment().tz("Asia/Kuala_Lumpur");
    // Use 'isoWeek' (WW) for work week number
    const year = now.format('GG');
    const week = now.format('WW');
    const formattedDate = year + week;

    logger.log(`Current Date: ${now.format('YYYY-MM-DD')}`);
    logger.log(`Formatted Year and Work Week (YYWW): ${formattedDate}`);
    
    return formattedDate;
};


module.exports = {

    getWWYY : getYearAndWorkWeek,

};



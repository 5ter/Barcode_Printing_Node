/**
 * Utility to control console output based on the environment.
 * Logs are enabled only if NODE_ENV is NOT 'production'.
 * Errors are always printed.
 */
const isProduction = process.env.NODE_ENV === 'production';

const customLogger = {
    // Suppress regular logs in production
    log: (...args) => {
        if (!isProduction) {
           console.log(...args);
        }
    },
    
    // Always log errors, regardless of environment
    error: (...args) => {
        console.error('SERVER ERROR:', ...args);
    },

    // Optional: Keep track of informational messages in all environments
    info: (...args) => {
        console.info('SERVER INFO:', ...args);
    }
};

module.exports = customLogger;

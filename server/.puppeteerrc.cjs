const { join } = require('path');

/**
 * Puppeteer configuration.
 * Sets the Chrome cache directory to within the project folder so it survives
 * Render's build-to-runtime transition. Without this, Puppeteer defaults to
 * ~/.cache/puppeteer which is outside the project and gets discarded.
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};

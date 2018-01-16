const puppeteer = require('puppeteer');
const json2csv = require('json2csv');
const fs = require('fs');

/**
 * Gets the number of pages based on the "Showing N results" text.
 * @param {object} page - The puppeteer page.
 * @returns {number} - The number of pages the list has.
 */
async function getNumberOfPages(page) {
  const jobs = await page.evaluate((selector) => {
    const resultsString = document.querySelector(selector).innerText;
    const numberOfResults = resultsString.replace(/[^\d.]/g, '');

    return parseInt(numberOfResults);
  }, '.jobs-search-results__count-string');

  // 25 results per page by default.
  return Math.ceil(jobs / 25);
}

/**
 * Navigates to the next page of the list.
 * @param {object} page - The puppeteer page.
 * @param {boolean} isLoggedIn - Boolean value indicating if the user is logged in or not.
 */
async function goToNextPage(page, isLoggedIn) {
  const btnNextPage = isLoggedIn ? (await page.$('button.next')) : (await page.$('a.next-btn'));

  if (btnNextPage) {
    btnNextPage.click();
  }
}

/**
 * Scrapes the data from the job page.
 * @param {object} page - The puppeteer page.
 * @param {string} url - The URL to scrape.
 * @param {boolean} isLoggedIn - Boolean value indicating if the user is logged in or not.
 * @returns {object} - The object containing the details of the job.
 */
async function crawlURL(page, url, isLoggedIn) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitFor(15000); // To avoid captcha (hopefully).

  const btnSeeMore = await page.$('button.view-more-icon');
  if (btnSeeMore) {
    btnSeeMore.click();
    await page.waitFor(15000);
  }

  await autoScroll(page);

  // Selectors. Not sure why LinkedIn's HTML structure isn't the same when a user is logged in and logged out.
  const selectors = {
    title: isLoggedIn ? 'h1.jobs-details-top-card__job-title' : 'h1.title',
    company: isLoggedIn ? 'a.jobs-details-top-card__company-url' : 'span.company',
    location: isLoggedIn ? 'h3.jobs-details-top-card__company-info span.jobs-details-top-card__bullet' : 'h3.location',
    datePosted: isLoggedIn ? 'p.jobs-details-top-card__job-info > span' : '.posted',
    description: isLoggedIn ? 'div.jobs-description-content__text' : '.summary',
    seniorityLevel: isLoggedIn ? 'p.js-formatted-exp-body' : '.experience .rich-text',
    industries: isLoggedIn ? 'ul.js-formatted-industries-list li' : '.industry .rich-text',
    employmentType: isLoggedIn ? 'p.js-formatted-employment-status-body' : '.employment .rich-text',
    jobFunctions: isLoggedIn ? 'ul.js-formatted-job-functions-list li' : '.function .rich-text',
  };

  const job = await page.evaluate((selectors) => {
    const title = document.querySelector(selectors.title) ? document.querySelector(selectors.title).innerText : '';
    const company = document.querySelector(selectors.company) ? document.querySelector(selectors.company).innerText : '';
    const location = document.querySelector(selectors.location) ? document.querySelector(selectors.location).innerText : '';
    const datePosted = document.querySelector(selectors.datePosted) ? document.querySelector(selectors.datePosted) : '';
    const description = document.getElementById(selectors.description) ? document.getElementById(selectors.description).innerHTML : '';
    const seniorityLevel = document.querySelector(selectors.seniorityLevel) ? document.querySelector(selectors.seniorityLevel).innerText : '';
    const extractNodeListInnerText = (nodeList) => {
      if (!nodeList) {
        return '';
      }

      return nodeList[0].nodeName === 'DIV' ? nodeList[0].innerText : Array.from(nodeList).map((li) => li.innerText).join(', ');
    };

    const industriesNodeList = document.querySelectorAll(selectors.industries);
    const industries = extractNodeListInnerText(industriesNodeList);
    const jobFunctionsNodeList = document.querySelectorAll(selectors.jobFunctions);
    const jobFunctions = extractNodeListInnerText(jobFunctionsNodeList);const employmentType = document.querySelector(selectors.employmentType) ? document.querySelector(selectors.employmentType).innerText : '';

    return {
      title,
      company,
      location,
      datePosted,
      description,
      seniorityLevel,
      industries,
      employmentType,
      jobFunctions,
    };
  }, selectors);

  return job;
}

/**
 * Logs the user in.
 * @param {object} page - The puppeteer page.
 * @param {string} url - The login page URL.
 */
async function login(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.setViewport({ width: 1903, height: 949 });
  await page.waitFor(1000);

  await page.focus('#login-email');
  await page.keyboard.type(process.env.EMAIL);
  await page.focus('#login-password');
  await page.keyboard.type(process.env.PASSWORD);
  
  const btnLogin = await page.$('#login-submit');
  await btnLogin.click();
}

/**
 * Handles the captcha. (Or not. Doesn't really work when captcha asks to click images. Whut.)
 * @param {object} page - The puppeteer page.
 */
async function handleCaptcha(page) {
  const chkCaptcha = await page.$('.recaptcha-checkbox-checkmark');

  if (chkCaptcha) {
    await chkCaptcha.click();
  }
}

// From https://github.com/GoogleChrome/puppeteer/issues/844#issuecomment-338916722
/**
 * Scrolls through the entire page until it reaches the bottom.
 * @param {object} page - The puppeteer page.
 */
function autoScroll(page) {
  return page.evaluate(() => {
    return new Promise((resolve, reject) => {
      let totalHeight = 0;
      const distance = 100;
      const scrollInterval = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(scrollInterval);
          resolve();
        }
      }, 100);
    });
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  const baseURL = 'https://www.linkedin.com';

  await login(page, baseURL);
  await page.waitFor(10000);
  await handleCaptcha(page);
  await page.waitFor(10000);
  await page.goto(`${baseURL}/jobs/search/?keywords=affiliate%20marketing&location=Worldwide&locationId=OTHERS.worldwide`, {
    waitUntil: 'domcontentloaded',
  });

  const numberOfPages = await getNumberOfPages(page);
  console.log('pages:', numberOfPages);

  let jobURLs = [];
  for (let i = 0; i < numberOfPages; i = i + 1) {
    // Check if logged in for every page; LinkedIn sometimes logs the user out if suspected as bot.
    const isLoggedIn = await page.$('img.nav-item__profile-member-photo') !== null;
    const linkSelector = isLoggedIn ? '.job-card-search__content-wrapper a.job-card-search__link-wrapper' : 'a.job-title-link';

    // Scroll through the page to show all the jobs.
    await autoScroll(page);
    await page.waitFor(20000);

    // Add the links to jobURLs[].
    const currentPageURLs = await page.evaluate((selector) => {
      const links = document.querySelectorAll(selector);
      return Array.from(links).map((link) => {
        return link.href;
      });
    }, linkSelector);

    jobURLs = jobURLs.concat(currentPageURLs);

    if (i < numberOfPages) {
      await goToNextPage(page, isLoggedIn);
    }
  }

  // Scrape the job pages for details.
  const data = [];
  for (let url of jobURLs) {
    const isLoggedIn = await page.$('img.nav-item__profile-member-photo') !== null;
    const job = await crawlURL(page, url, isLoggedIn);
    
    data.push(job);
  }

  // Covert json to csv.
  const fields = Object.keys(jobs[0]);
  const csv = json2csv({
    data,
    fields,
  });

  // Export csv to file.
  fs.writeFile('linkedin_affiliate_marketing.csv', csv, (error) => {
    if (error) {
      throw error;
    }

    browser.close();
    console.log('file saved.');
  });
})();

-Axios 
: it is a popular promise based http client,Its job is to go out to the internet, make an HTTP request to a website's URL, and bring back the raw data—specifically, the HTML code of that page.
: Axios only grabs the static HTML source code. It cannot run JavaScript on the page or interact with buttons. If a website relies heavily on client-side JavaScript to load content (like a Single Page App built with React), Axios might only return an empty shell like <div id="root"></div>.

-Cheerio 
: Cheerio is a fast, flexible implementation of core jQuery designed specifically for the server. 
: Once Axios brings back the raw HTML string, Cheerio parses it and builds a lightweight DOM (Document Object Model) in memory.
:Because Cheerio doesn't actually render a browser window, it is extremely fast and uses very little memory compared to browser automation tools like Puppeteer or Selenium.

~jQuery :-

/jQuery is a fast, lightweight js library designed  to simplify how you interact with web pages.
/It acts as a shortcut toolkit, turning long, complex JavaScript code into short, easy-to-read commands using the $ symbol.
/Developers use it to easily select elements, handle user clicks, animate visuals, and update content without reloading the page.

/imagine u want to hide a button then :
~in plain js - document.getElementById('myButton').style.display = 'none';
~in jQuery - $('#myButton').hide()


# const $ = cheerio.load(response.data);

/This single line of JavaScript/TypeScript code is commonly used in web scraping. It takes raw HTML data (usually fetched from a website using an HTTP client like Axios) and loads it into Cheerio, allowing you to parse, manipulate, and traverse the HTML much like you would using jQuery in a web browser.

/cheerio.load(...): This is the core function of the Cheerio library. It parses the raw HTML string and builds a fast, lightweight, server-side DOM (Document Object Model) representation of the page.

const $ =: By convention, the variable is named $ (a single dollar sign). This mimics jQuery, making it familiar and intuitive for developers to write selectors (e.g., $('h1').text() or $('.price')).

# $("h1, h2, h3").each((index, element) => {
#        console.log($(element).text().trim());
#  });
#
~In that snippet, index and element are the parameters automatically passed by Cheerio’s .each() loop into your callback function for every matching item it finds on the page.

# const data = parseHTML(response.data);
~why did we just not write response? 
~if we would hv just written response, we would be handling the whole package to the parser, but the parser specifically needs the raw HTML content, not the delivery details.
~response.data - raw HTML code

# function cleanText(text){
#    return text.replace(/\s+/g, " ").trim();
# }
~it speaks about replacing text with " ".
~/s - tab, whitespace etc
~+ - more than one, spaces
~/g - whitespaces , one or more than one, found globally throughout the code.

# const { PDFParse } = require("pdf-parse");
~this imports a llibrary (a pre written toolkit) called pdf-parse which specilizes in reading files.

# async function parsePDF(url) {
~This creates an asynchronous function (meaning it can pause and wait for things like downloading files) that takes a web link (url) pointing to a PDF.

#  const parser = new PDFParse({ url });
~This sets up a new parser tool specifically targeted at the PDF file located at that web address.

#  const result = await parser.getText();
~This tells the program to download the PDF in the background, read every page, extract all the written words, and wait (await) until it's completely finished.

#  await parser.destroy();
~Once the text has been successfully grabbed, this closes and cleans up the parser. It’s like turning off a machine or closing a tab when you're done to save computer memory.

#  return result.text;
~This sends back only the extracted text content so the rest of your app can use it (for example, to summarize or search through the PDF).

# }

# module.exports = parsePDF;




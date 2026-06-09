const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;

// Simple UI Helper HTML
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Flipkart Cloud Scraper</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; background-color: #f4f4f9; }
                .container { background: white; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0px 4px 10px rgba(0,0,0,0.1); }
                input[type="file"] { margin: 20px 0; }
                button { background: #28a745; color: white; border: none; padding: 10px 20px; font-size: 16px; border-radius: 5px; cursor: pointer; }
                button:hover { background: #218838; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Flipkart Automation Cloud Panel ☁️</h2>
                <p>Upload your <b>links.csv</b> file below:</p>
                <form action="/scrape" method="POST" enctype="multipart/form-data">
                    <input type="file" name="excelFile" accept=".csv" required><br>
                    <button type="submit">Start Scraping & Download</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// Main Scraping Endpoint
app.post('/scrape', upload.single('excelFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('❌ File upload nahi hui.');

    const allExtractedData = [];
    const fileContent = fs.readFileSync(req.file.path, { encoding: 'utf-8' });
    
    let records;
    try {
        records = parse(fileContent, { columns: true, skip_empty_lines: true });
    } catch (err) {
        return res.status(400).send('❌ Invalid CSV format.');
    }

    // Launching Playwright in headless mode for Cloud Environment
    console.log("Launching Headless Cloud Chromium...");
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    for (const record of records) {
        const url = record.Link || record.url || Object.values(record)[1];
        const fsn = record.FSN || 'Unknown';
        
        if (!url || !url.startsWith('http')) continue;

        try {
            const urlObj = new URL(url);
            const pidValue = urlObj.searchParams.get('pid') || '';
            const reviewsDirectUrl = `https://www.flipkart.com/product/product-reviews/itm?pid=${pidValue}&marketplace=FLIPKART`;
            
            await page.goto(reviewsDirectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);

            // Matrix Parsing Logic
            const finalMetrics = await page.evaluate(() => {
                const doc = document;
                const breakdown = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0, totalRatings: "0", average: "0.0" };
                if (!doc) return breakdown;

                const bodyText = doc.body?.innerText || '';
                const totalMatch = bodyText.match(/([\d,]+)\s+ratings\s+and/i);
                if (totalMatch) breakdown.totalRatings = totalMatch[1];

                const rows = doc.querySelectorAll('div.css-g5y9jx.r-1awozwy.r-18u37iz');
                rows.forEach((row) => {
                    const elements = Array.from(row.querySelectorAll('div, span'))
                        .map((el) => el.textContent?.trim() || '')
                        .filter((str) => str.length > 0 && !str.includes('★'));

                    if (elements.length >= 2) {
                        const starIndex = elements[0]; 
                        const countVal = elements[elements.length - 1]; 
                        if (/^[1-5]$/.test(starIndex)) {
                            const countInt = parseInt(countVal.replace(/,/g, ''), 10) || 0;
                            if (starIndex === '1') breakdown.star1 = countInt;
                            if (starIndex === '2') breakdown.star2 = countInt;
                            if (starIndex === '3') breakdown.star3 = countInt;
                            if (starIndex === '4') breakdown.star4 = countInt;
                            if (starIndex === '5') breakdown.star5 = countInt;
                        }
                    }
                });

                const sum = breakdown.star1 + breakdown.star2 + breakdown.star3 + breakdown.star4 + breakdown.star5;
                if (sum > 0) {
                    breakdown.average = ((breakdown.star1 * 1 + breakdown.star2 * 2 + breakdown.star3 * 3 + breakdown.star4 * 4 + breakdown.star5 * 5) / sum).toFixed(1);
                    if (breakdown.totalRatings === "0") breakdown.totalRatings = sum.toString();
                }
                return breakdown;
            });

            // Reviews text parsing 
            const reviews = await page.evaluate(() => {
                const doc = document;
                if (!doc) return [];
                const data = [];
                const reviewBlocks = doc.querySelectorAll('div');

                reviewBlocks.forEach((block) => {
                    const text = block.innerText || '';
                    if (text.includes('Verified Buyer') && text.length < 600) {
                        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
                        if (lines.length >= 3) {
                            const userRating = lines[0].match(/^[1-5]/) ? lines[0].substring(0,1) : '5';
                            const title = lines[1] || 'Review';
                            const comment = lines[2] || '';
                            const author = lines[lines.length - 2] || 'Anonymous';
                            if (comment.length > 3 && author !== 'Verified Buyer' && author !== 'Home') {
                                data.push({ author, rating: userRating, title, comment });
                            }
                        }
                    }
                });
                return data;
            });

            const uniqueReviews = Array.from(new Set(reviews.map((a) => JSON.stringify(a)))).map((e) => JSON.parse(e));

            if (uniqueReviews.length === 0) {
                allExtractedData.push({
                    FSN: fsn, URL: url, Author: 'N/A', User_Rating: 'N/A', Title: 'N/A', Comment: 'No reviews found',
                    Average_Rating: finalMetrics.average, Total_Ratings_Count: finalMetrics.totalRatings,
                    Star5_Count: finalMetrics.star5, Star4_Count: finalMetrics.star4, Star3_Count: finalMetrics.star3, Star2_Count: finalMetrics.star2, Star1_Count: finalMetrics.star1
                });
            } else {
                uniqueReviews.forEach((rev) => {
                    allExtractedData.push({
                        FSN: fsn, URL: url, Author: rev.author, User_Rating: rev.rating, Title: rev.title, Comment: rev.comment,
                        Average_Rating: finalMetrics.average, Total_Ratings_Count: finalMetrics.totalRatings,
                        Star5_Count: finalMetrics.star5, Star4_Count: finalMetrics.star4, Star3_Count: finalMetrics.star3, Star2_Count: finalMetrics.star2, Star1_Count: finalMetrics.star1
                    });
                });
            }
        } catch (err) {
            console.error(`Error processing FSN ${fsn}:`, err);
        }
    }

    await browser.close();
    fs.unlinkSync(req.file.path); // Temp file clear karein

    // CSV Respond compiled output data sheets
    if (allExtractedData.length > 0) {
        const headers = ["FSN", "Product_URL", "Average_Rating", "Total_Ratings_Count", "Reviewer_Name", "User_Rating", "Review_Title", "Review_Comment", "5_Star_Total", "4_Star_Total", "3_Star_Total", "2_Star_Total", "1_Star_Total"];
        const csvRows = allExtractedData.map(row => [
            `"${row.FSN}"`, `"${row.URL}"`, `"${row.Average_Rating}"`, `"${row.Total_Ratings_Count}"`,
            `"${row.Author.replace(/"/g, '""')}"`, `"${row.User_Rating}"`, `"${row.Title.replace(/"/g, '""')}"`,
            `"${row.Comment.replace(/\n/g, ' ').replace(/"/g, '""')}"`, `"${row.Star5_Count}"`, `"${row.Star4_Count}"`, `"${row.Star3_Count}"`, `"${row.Star2_Count}"`, `"${row.Star1_Count}"`
        ].join(","));

        const csvContent = [headers.join(","), ...csvRows].join("\n");
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=flipkart_cloud_report.csv');
        return res.status(200).send(csvContent);
    } else {
        return res.status(500).send("❌ Scraping failed or returned no data.");
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

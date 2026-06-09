import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

interface Row {
    url: string;
}

const allExtractedData: any[] = [];

// Smooth auto-scroll logic
async function autoScroll(page: any) {
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 150; 
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight || totalHeight > 4000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 80); 
        });
    });
}

async function scrapeFlipkartReviews() {
    console.log("=== [STEP 1] Script Started ===");
    
    const csvFilePath = path.resolve(__dirname, 'links.csv');
    if (!fs.existsSync(csvFilePath)) {
        console.error("❌ Error: 'links.csv' file nahi mili!");
        return;
    }

    const fileContent = fs.readFileSync(csvFilePath, { encoding: 'utf-8' });
    const records: Row[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
    });

    console.log(`=== [STEP 2] Total links found in CSV: ${records.length} ===`);

    // Standard fallback options ke sath default browser launch
    const browser = await chromium.launch({ headless: false }); 
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    for (const record of records) {
        const url = (record as any).Link || record.url || Object.values(record)[1];
        const fsn = (record as any).FSN || 'Unknown';
        
        if (!url || !url.startsWith('http')) {
            continue;
        }

        try {
            const urlObj = new URL(url);
            const pidValue = urlObj.searchParams.get('pid') || '';
            const reviewsDirectUrl = `https://www.flipkart.com/product/product-reviews/itm?pid=${pidValue}&marketplace=FLIPKART`;
            
            console.log(`\n🚀 Opening Reviews Link for FSN [${fsn}]:\n   --> ${reviewsDirectUrl}`);
            
            await page.goto(reviewsDirectUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await autoScroll(page);
            await page.waitForTimeout(3000);

            // === 1. POSITION BASED MATRIX PARSING ===
            const finalMetrics = await page.evaluate(() => {
                const doc = (globalThis as any).document;
                const breakdown = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0, totalRatings: "0", average: "0.0" };
                
                if (!doc) return breakdown;

                const bodyText = doc.body?.innerText || '';
                const totalMatch = bodyText.match(/([\d,]+)\s+ratings\s+and/i);
                if (totalMatch) breakdown.totalRatings = totalMatch[1];

                const rows = doc.querySelectorAll('div.css-g5y9jx.r-1awozwy.r-18u37iz');
                
                rows.forEach((row: any) => {
                    const elements = Array.from(row.querySelectorAll('div, span'))
                        .map((el: any) => el.textContent?.trim() || '')
                        .filter((str: string) => str.length > 0 && !str.includes('★'));

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

            console.log(`⭐ Product Average Score: ${finalMetrics.average} (${finalMetrics.totalRatings} Total Ratings)`);
            console.log(`📊 Matrix Captured -> 5★:${finalMetrics.star5} | 4★:${finalMetrics.star4} | 3★:${finalMetrics.star3} | 2★:${finalMetrics.star2} | 1★:${finalMetrics.star1}`);

            // === 2. TEXT-BASED REVIEWS EXTRACTION ===
            const reviews = await page.evaluate(() => {
                const doc = (globalThis as any).document;
                if (!doc) return [];

                const data: any[] = [];
                const reviewBlocks = doc.querySelectorAll('div');

                reviewBlocks.forEach((block: any) => {
                    const text = block.innerText || '';
                    if (text.includes('Verified Buyer') && text.length < 600) {
                        const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
                        
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

            const uniqueReviews = Array.from(new Set(reviews.map((a: any) => JSON.stringify(a)))).map((e: any) => JSON.parse(e));
            console.log(`✅ Reviews parsed successfully on this page: ${uniqueReviews.length}`);

            if (uniqueReviews.length === 0) {
                allExtractedData.push({
                    FSN: fsn, URL: url, Author: 'N/A', User_Rating: 'N/A', Title: 'N/A', Comment: 'No written text reviews found on page',
                    Average_Rating: finalMetrics.average, Total_Ratings_Count: finalMetrics.totalRatings,
                    Star5_Count: finalMetrics.star5, Star4_Count: finalMetrics.star4, Star3_Count: finalMetrics.star3, Star2_Count: finalMetrics.star2, Star1_Count: finalMetrics.star1
                });
            } else {
                uniqueReviews.forEach((rev: any) => {
                    allExtractedData.push({
                        FSN: fsn, URL: url, Author: rev.author, User_Rating: rev.rating, Title: rev.title, Comment: rev.comment,
                        Average_Rating: finalMetrics.average, Total_Ratings_Count: finalMetrics.totalRatings,
                        Star5_Count: finalMetrics.star5, Star4_Count: finalMetrics.star4, Star3_Count: finalMetrics.star3, Star2_Count: finalMetrics.star2, Star1_Count: finalMetrics.star1
                    });
                });
            }

        } catch (error) {
            console.error(`❌ Parse Error logic module:`, error);
        }
    }

    console.log("\n=== [FINISHED] Closing Browser ===");
    await browser.close();

    // === 3. WRITE TO CSV EXCEL ===
    if (allExtractedData.length > 0) {
        console.log("\n=== [STEP 4] Exporting Final Dataset to Excel CSV ===");
        const headers = ["FSN", "Product_URL", "Average_Rating", "Total_Ratings_Count", "Reviewer_Name", "User_Rating", "Review_Title", "Review_Comment", "5_Star_Total", "4_Star_Total", "3_Star_Total", "2_Star_Total", "1_Star_Total"];
        
        const csvRows = allExtractedData.map(row => {
            return [
                `"${row.FSN.replace(/"/g, '""')}"`,
                `"${row.URL.replace(/"/g, '""')}"`,
                `"${row.Average_Rating}"`,
                `"${row.Total_Ratings_Count}"`,
                `"${row.Author.replace(/"/g, '""')}"`,
                `"${row.User_Rating}"`,
                `"${row.Title.replace(/"/g, '""')}"`,
                `"${row.Comment.replace(/\n/g, ' ').replace(/"/g, '""')}"`,
                `"${row.Star5_Count}"`,
                `"${row.Star4_Count}"`,
                `"${row.Star3_Count}"`,
                `"${row.Star2_Count}"`,
                `"${row.Star1_Count}"`
            ].join(",");
        });

        const csvContent = [headers.join(","), ...csvRows].join("\n");
        const outputFilePath = path.resolve(__dirname, 'flipkart_calculated_reviews_report.csv');
        fs.writeFileSync(outputFilePath, csvContent, 'utf-8');
        
        console.log(`\n🎉 Success! Output sheet compile ho chuki hai.`);
        console.log(`📂 File Location: ${outputFilePath}`);
    }
}

scrapeFlipkartReviews();

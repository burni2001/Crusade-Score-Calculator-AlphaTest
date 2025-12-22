// Store OCR results for review
let pendingOCRResults = {};
let rawOCRText = "";

// Screenshot Upload and OCR Processing
document
    .getElementById("screenshot-upload")
    .addEventListener("change", async function (e) {
        const files = e.target.files;
        if (files.length === 0) return;

        const statusDiv = document.getElementById("upload-status");
        const progressDiv =
            document.getElementById("upload-progress");

        statusDiv.textContent = "Processing screenshots...";
        statusDiv.style.color = "var(--pip-green)";

        // Reset pending results
        pendingOCRResults = {};
        rawOCRText = "";

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                progressDiv.textContent = `Processing image ${i + 1} of ${files.length}...`;

                await processScreenshot(
                    file,
                    statusDiv,
                    progressDiv,
                );
            }

            // Parse combined OCR text from all screenshots
            parseGameData(rawOCRText);

            statusDiv.textContent =
                "OCR complete - review results below";
            statusDiv.style.color = "#afffa6";
            progressDiv.textContent = "";

            // Show the review modal
            showOCRModal();

            // Clear the file input for future uploads
            e.target.value = "";
        } catch (error) {
            console.error("OCR Error:", error);
            const errorMsg =
                error.message ||
                error.toString() ||
                "Unknown error";
            statusDiv.textContent = `Error: ${errorMsg}`;
            statusDiv.style.color = "#ff3300";
            progressDiv.textContent = "";
        }
    });

// OCR API keys (base64 encoded for light obfuscation - not security)
// Primary and fallback keys for rate limit resilience
const _k1 = "Szg4MDc3MzI3NTg4OTU3";
const _k2 = "Szg1NjUwNzU2OTg4OTU3";
function getOCRKey(index = 0) {
    return atob(index === 0 ? _k1 : _k2);
}

// Split image into left and right halves for dual-pass OCR
// Left half: uncropped (mission header)
// Right half: upscaled (stats panel with numbers)
async function splitImageForOCR(dataUrl, maxSizeKB = 900) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function () {
            const origWidth = img.width;
            const origHeight = img.height;

            // Split point at 50% of image width
            const splitX = Math.round(origWidth * 0.5);

            // === LEFT HALF (for mission header) ===
            // Keep at original size, just crop to left portion
            const leftCanvas = document.createElement("canvas");
            const leftCtx = leftCanvas.getContext("2d");
            leftCanvas.width = splitX;
            leftCanvas.height = origHeight;
            leftCtx.drawImage(
                img,
                0,
                0,
                splitX,
                origHeight,
                0,
                0,
                splitX,
                origHeight,
            );
            let leftResult = leftCanvas.toDataURL(
                "image/jpeg",
                0.85,
            );

            // Compress left if needed
            let leftQuality = 0.85;
            while (
                leftResult.length > maxSizeKB * 1024 * 1.37 &&
                leftQuality > 0.4
            ) {
                leftQuality -= 0.1;
                leftResult = leftCanvas.toDataURL(
                    "image/jpeg",
                    leftQuality,
                );
            }

            // === RIGHT HALF (for stats panel) ===
            // Crop aggressively to stats table only (skip headers, footers, edges)
            const rightCanvas = document.createElement("canvas");
            const rightCtx = rightCanvas.getContext("2d");
            const rightWidth = origWidth - splitX;

            // Aggressive crop: keep only middle 80% vertically (skip headers/footers)
            // and right 90% horizontally (skip left labels/edges)
            const cropTopPercent = 0.1; // Skip top 10%
            const cropBottomPercent = 0.15; // Skip bottom 15%
            const cropLeftPercent = 0.05; // Skip left edge 5%
            const cropRightPercent = 0.05; // Skip right edge 5%

            const statsX = Math.round(rightWidth * cropLeftPercent);
            const statsY = Math.round(origHeight * cropTopPercent);
            const statsWidth = Math.round(
                rightWidth *
                    (1 - cropLeftPercent - cropRightPercent),
            );
            const statsHeight = Math.round(
                origHeight *
                    (1 - cropTopPercent - cropBottomPercent),
            );

            // Upscale cropped stats area to 1200px width for better OCR
            const targetWidth = 1200;
            const scale = targetWidth / statsWidth;
            const targetHeight = Math.round(statsHeight * scale);

            rightCanvas.width = targetWidth;
            rightCanvas.height = targetHeight;
            rightCtx.drawImage(
                img,
                splitX + statsX,
                statsY,
                statsWidth,
                statsHeight,
                0,
                0,
                targetWidth,
                targetHeight,
            );

            // Compress right half
            let rightQuality = 0.9;
            let rightResult = rightCanvas.toDataURL(
                "image/jpeg",
                rightQuality,
            );

            while (
                rightResult.length > maxSizeKB * 1024 * 1.37 &&
                rightQuality > 0.4
            ) {
                rightQuality -= 0.1;
                rightResult = rightCanvas.toDataURL(
                    "image/jpeg",
                    rightQuality,
                );
            }

            // If right still too large, reduce dimensions
            let currentWidth = targetWidth;
            while (
                rightResult.length > maxSizeKB * 1024 * 1.37 &&
                currentWidth > 600
            ) {
                currentWidth = Math.round(currentWidth * 0.85);
                const currentHeight = Math.round(
                    origHeight * (currentWidth / rightWidth),
                );
                rightCanvas.width = currentWidth;
                rightCanvas.height = currentHeight;
                rightCtx.drawImage(
                    img,
                    splitX,
                    0,
                    rightWidth,
                    origHeight,
                    0,
                    0,
                    currentWidth,
                    currentHeight,
                );
                rightResult = rightCanvas.toDataURL(
                    "image/jpeg",
                    0.85,
                );
            }

            resolve({ left: leftResult, right: rightResult });
        };
        img.src = dataUrl;
    });
}

// Helper function to call OCR.space API with fallback support
async function callOCRAPI(
    base64Image,
    apiKey,
    useTable = false,
    isRetry = false,
) {
    const formData = new FormData();
    formData.append("base64Image", base64Image);
    formData.append("language", "eng");
    formData.append("isOverlayRequired", "false");
    formData.append("OCREngine", "2");
    formData.append("scale", "true");
    if (useTable) {
        formData.append("isTable", "true");
    }

    const response = await fetch(
        "https://api.ocr.space/parse/image",
        {
            method: "POST",
            headers: { apikey: apiKey },
            body: formData,
        },
    );

    const result = await response.json();

    if (result.IsErroredOnProcessing) {
        const errorMsg =
            result.ErrorMessage || "OCR processing failed";
        // Check if it's a rate limit or key issue
        if (
            (errorMsg.includes("limit") ||
                errorMsg.includes("Invalid API")) &&
            !isRetry
        ) {
            throw new Error(`${errorMsg} [RETRY_WITH_FALLBACK]`);
        }
        throw new Error(errorMsg);
    }

    if (result.ParsedResults && result.ParsedResults.length > 0) {
        return result.ParsedResults[0].ParsedText;
    }
    return "";
}

async function processScreenshot(file, statusDiv, progressDiv) {
    let apiKey = getOCRKey(0); // Start with primary key
    let keyIndex = 0;

    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = async function (e) {
            try {
                const base64Image = e.target.result;

                if (apiKey) {
                    // DUAL-PASS OCR: Split image into left (header) and right (stats) halves
                    progressDiv.textContent = "Splitting image...";
                    const { left, right } =
                        await splitImageForOCR(base64Image);

                    // Pass 1: OCR left half for mission header (no table mode)
                    progressDiv.textContent =
                        "OCR: left half (headers)...";
                    let leftText = "";
                    try {
                        leftText = await callOCRAPI(
                            left,
                            apiKey,
                            false,
                            false,
                        );
                    } catch (err) {
                        if (
                            err.message.includes(
                                "RETRY_WITH_FALLBACK",
                            ) &&
                            keyIndex === 0
                        ) {
                            apiKey = getOCRKey(1); // Switch to fallback key
                            keyIndex = 1;
                            progressDiv.textContent =
                                "OCR: trying fallback key...";
                            leftText = await callOCRAPI(
                                left,
                                apiKey,
                                false,
                                true,
                            );
                        } else {
                            throw err;
                        }
                    }

                    // Pass 2: OCR right half for stats table (table mode + upscaled)
                    progressDiv.textContent =
                        "OCR: right half (stats)...";
                    const rightText = await callOCRAPI(
                        right,
                        apiKey,
                        true,
                        keyIndex > 0,
                    );

                    // Combine results: left half first (headers), then right half (stats)
                    const combinedText = `[LEFT]\n${leftText}\n[RIGHT]\n${rightText}`;
                    rawOCRText += combinedText + "\n\n---\n\n";

                    progressDiv.textContent = "OCR complete";
                } else {
                    // Fallback to Tesseract.js (less accurate but works without key)
                    if (typeof Tesseract === "undefined") {
                        throw new Error(
                            "OCR library not loaded. Please refresh the page.",
                        );
                    }

                    progressDiv.textContent =
                        "Processing with basic OCR...";

                    try {
                        const result = await Tesseract.recognize(
                            base64Image,
                            "eng",
                            {
                                logger: (m) => {
                                    if (
                                        m.status ===
                                        "recognizing text"
                                    ) {
                                        progressDiv.textContent = `Basic OCR: ${Math.round(m.progress * 100)}%`;
                                    }
                                },
                            },
                        );

                        const text = result.data.text;
                        rawOCRText += text + "\n\n---\n\n";
                        progressDiv.textContent =
                            "OCR complete (basic mode)";
                    } catch (tessError) {
                        console.error(
                            "Tesseract error:",
                            tessError,
                        );
                        throw new Error(
                            "Basic OCR failed. Try adding an API key for better results.",
                        );
                    }
                }

                resolve();
            } catch (error) {
                reject(error);
            }
        };

        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function parseGameData(text) {
    // Heavy normalization for OCR text
    // Step 1: Remove symbols and normalize
    let normalized = text
        .replace(/[★☆✦✧⭐\u2605\u2606]/g, "") // Remove star symbols
        .replace(/[|©®™]/g, " ") // Remove special chars
        .replace(/xp\s*\d+/gi, " ") // Remove "XP 10" badges
        .replace(/xb\s*\d+/gi, " ") // Remove "XB 10" (OCR misread)
        .replace(/7k\b/gi, "") // Remove "7k" OCR artifact
        .replace(/[''`]/g, "'") // Normalize quotes
        .replace(/[""]/g, '"'); // Normalize double quotes

    // Step 2: Create uppercase version for matching
    let upperText = normalized.toUpperCase();

    // Step 3: Split into lines
    const lines = normalized
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const upperSingleLine = upperText
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ");

    // === MISSION NAME ===
    const knownMissions = [
        "RECLAMATION", "INFERNO", "BALLISTIC", "DECAPITATION", "SERVO",
        "SKULL", "VANGUARD", "VOIDSONG", "RELIQUARY", "TERMINATION",
        "EXTRACTION", "ATHENA",
    ];

    let missionMatch = upperSingleLine.match(
        /MISSION\s*[:\-=]?\s*([A-Z][A-Z\s\-']{2,30})/,
    );
    if (missionMatch) {
        let missionName = missionMatch[1].trim();
        missionName = missionName.replace(/\s*STATUS.*$/i, "").trim();
        if (missionName.length > 2) {
            pendingOCRResults["mission-name"] =
                missionName.charAt(0) + missionName.slice(1).toLowerCase();
        }
    }

    if (!pendingOCRResults["mission-name"]) {
        for (const mission of knownMissions) {
            if (upperText.includes(mission)) {
                pendingOCRResults["mission-name"] =
                    mission.charAt(0) + mission.slice(1).toLowerCase();
                break;
            }
        }
    }

    // === DIFFICULTY ===
    const difficulties = [
        "MINIMAL", "AVERAGE", "SUBSTANTIAL", "RUTHLESS", "LETHAL", "ABSOLUTE",
    ];
    for (const diff of difficulties) {
        if (upperText.includes(diff)) {
            pendingOCRResults["mission-difficulty"] =
                diff.charAt(0) + diff.slice(1).toLowerCase();
            break;
        }
    }

    // === STATUS: SUCCESS ===
    if (
        /STATUS\s*[:\-=]?\s*SUCCESS/i.test(upperText) ||
        /\bVICTORY\b/i.test(upperText)
    ) {
        pendingOCRResults["global-objective"] = "1";
    }

    // === GENE-SEED ===
    const hasGeneseed = /GENE.?SEED/i.test(upperText);
    const hasFound = /FOUND|RETRIEVED/i.test(upperText);
    const hasSecondaryObj = /SECONDARY\s*OBJECTIVES/i.test(upperText);
    const geneseedWithXP = /GENE.?SEED.*?XP\s*\d+/i.test(upperSingleLine);

    if (hasGeneseed && (hasFound || geneseedWithXP || hasSecondaryObj)) {
        pendingOCRResults["global-geneseed"] = "1";
    }

    // === PLAYER NAME AND CLASS ===
    function levenshtein(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                matrix[i][j] =
                    b[i - 1] === a[j - 1]
                        ? matrix[i - 1][j - 1]
                        : Math.min(
                                matrix[i - 1][j - 1] + 1,
                                matrix[i][j - 1] + 1,
                                matrix[i - 1][j] + 1,
                            );
            }
        }
        return matrix[b.length][a.length];
    }

    const canonicalClasses = [
        "BULWARK", "ASSAULT", "VANGUARD", "TACTICAL", "SNIPER", "HEAVY", "TECHMARINE",
    ];

    const ocrClassFixes = {
        ANGUNRO: "VANGUARD", ANGUARD: "VANGUARD", VANGUNRD: "VANGUARD",
        VANGURD: "VANGUARD", BULWAR: "BULWARK", BÜLWARK: "BULWARK",
        ASSAUL: "ASSAULT", ASSAUT: "ASSAULT", TACTIAL: "TACTICAL",
        SNIPE: "SNIPER", TECHMAR: "TECHMARINE", ECHMAR: "TECHMARINE",
    };

    function matchClass(word) {
        const upper = word.toUpperCase();
        if (canonicalClasses.includes(upper)) return upper;
        if (ocrClassFixes[upper]) return ocrClassFixes[upper];
        let bestMatch = null;
        let bestDist = 3;
        for (const cls of canonicalClasses) {
            const dist = levenshtein(upper, cls);
            if (dist < bestDist) {
                bestDist = dist;
                bestMatch = cls;
            }
        }
        return bestDist <= 2 ? bestMatch : null;
    }

    function formatClass(cls) {
        return cls.charAt(0).toUpperCase() + cls.slice(1).toLowerCase();
    }

    const foundPlayers = [];

    // Helper: Extract a valid player name from a line
    function extractPlayerName(line) {
        // First try to extract names FROM brackets
        // FIXED: Explicitly ignore [LEFT] and [RIGHT] inside brackets
        const bracketContent = line.match(
            /\[(?:jr\s+)?([A-ZÄÖÜ][a-zäöüß\u00E0-\u00FF0-9]+(?:\s+[A-Za-zäöüß\u00E0-\u00FF0-9]+)*)\s*[qQ\]®]/i,
        );
        if (bracketContent && bracketContent[1].length >= 3) {
            let extracted = bracketContent[1]
                .trim()
                .replace(/\s+[a-zA-Z]$/g, "")
                .trim();
            
            // FIX: If extracted name is literally "RIGHT" or "LEFT", ignore it
            if (/^(RIGHT|LEFT)$/i.test(extracted)) return null;

            if (
                !/^(Kills|Special|Heavy|Assault|Bulwark|Vanguard|Tactical|Sniper)/i.test(
                    extracted,
                )
            ) {
                return extracted;
            }
        }

        // Remove brackets and clean the line
        const cleanLine = line.replace(/\[.*?\]/g, "").trim();

        // Filter out OCR preprocessing markers
        if (/^\[?(LEFT|RIGHT)\]?$/i.test(cleanLine)) {
            return null;
        }

        const gameTerms =
            /^(Kills|Special|Melee|Ranged|Damage|Items|Total|Score|Next|Status|Mission|Rewards|Character|Progress|Primary|Secondary|Objectives|Found|Taken|Revived|Incap|Success|Assault|Vanguard|Bulwark|Tactical|Sniper|Heavy|TRUER|SYREN)$/i;

        function isValidName(name) {
            if (!name || name.length < 3) return false;
            if (gameTerms.test(name)) return false;
            if (/^(.)\1+$/i.test(name)) return false; // Reject "EEE"
            const midUppers = (name.slice(1, -1).match(/[A-Z]/g) || []).length;
            if (name.length <= 5 && midUppers > 1) return false;
            
            // FIX: Reject all-caps ONLY if very short. Allow longer tags.
            if (name === name.toUpperCase() && name.length < 4) return false;

            // FIX: Relaxed letter count check to allow Gamer Tags with numbers (Winnie20787)
            const letterCount = (
                name.match(/[a-zA-ZäöüÄÖÜß\u00C0-\u00FF]/g) || []
            ).length;
            if (letterCount < name.length * 0.4) return false;

            return true;
        }

        // Strategy A: Proper case names (Updated to allow digits 0-9)
        const properMatch = cleanLine.match(
            /\b([A-ZÄÖÜ][a-zäöüß\u00E0-\u00FF0-9]{2,}(?:\s+[A-ZÄÖÜ]?[a-zäöüß\u00E0-\u00FF0-9]{2,})*)\b/,
        );
        if (properMatch && isValidName(properMatch[1])) {
            let cleaned = properMatch[1].replace(/\s+[a-z]{1,2}$/i, "").trim();
            cleaned = cleaned.replace(/\s+\S{1,2}$/g, "").trim();
            return cleaned;
        }

        // Strategy B: Mixed case names (Updated to allow digits 0-9)
        const mixedMatch = cleanLine.match(
            /\b([A-ZÄÖÜ][A-Za-zäöüß\u00C0-\u00FF0-9]{3,})\b/,
        );
        if (mixedMatch && isValidName(mixedMatch[1])) {
            return mixedMatch[1];
        }

        return null;
    }

    // STRATEGY 1: Look for class names with [a] or [i] markers
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const markerMatch = line.match(
            /([A-Za-zÄÖÜäöü]{4,})\s*\[([aieAIEof0-9]{1,2})\]/i,
        );
        if (markerMatch) {
            const potentialClass = markerMatch[1];
            const matchedClass = matchClass(potentialClass);

            if (matchedClass && foundPlayers.length < 3) {
                const beforeMatch = line.substring(
                    0,
                    line.indexOf(markerMatch[0]),
                );
                if (/MAX\b/i.test(beforeMatch)) continue;

                let foundName = null;
                if (beforeMatch.trim()) {
                    const sameLine = beforeMatch
                        .replace(/[|:$#\[\]0-9]/g, " ")
                        .trim();
                    const sameLineName = extractPlayerName(sameLine);
                    if (sameLineName) {
                        const isDuplicate = foundPlayers.some(
                            (p) => p.name === sameLineName,
                        );
                        if (!isDuplicate) foundName = sameLineName;
                    }
                }

                if (!foundName) {
                    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                        const name = extractPlayerName(lines[j]);
                        if (name) {
                            const isDuplicate = foundPlayers.some(
                                (p) => p.name === name,
                            );
                            if (!isDuplicate) {
                                foundName = name;
                                break;
                            }
                        }
                    }
                }

                if (foundName) {
                    foundPlayers.push({
                        name: foundName,
                        class: formatClass(matchedClass),
                    });
                }
            }
        }
    }

    // STRATEGY 2: Look for name [i] pattern
    if (foundPlayers.length < 3) {
        for (let i = 0; i < lines.length; i++) {
            if (foundPlayers.length >= 3) break;
            const line = lines[i];
            const nameMarkerMatch = line.match(
                /([A-ZÄÖÜ][a-zäöüß\u00E0-\u00FF0-9]+(?:\s+[A-Za-zäöüß\u00E0-\u00FF0-9]+)*)\s*\[i\]/i,
            );
            if (nameMarkerMatch) {
                const candidateName = nameMarkerMatch[1].trim();
                if (candidateName.length >= 3) {
                    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
                        const classLine = lines[j];
                        const classMatch = classLine.match(
                            /([A-Za-zÄÖÜäöü]{4,})\s*\[a\]/i,
                        );
                        if (classMatch) {
                            const matchedClass = matchClass(classMatch[1]);
                            if (matchedClass) {
                                const isDuplicate = foundPlayers.some(
                                    (p) => p.name === candidateName,
                                );
                                if (!isDuplicate) {
                                    foundPlayers.push({
                                        name: candidateName,
                                        class: formatClass(matchedClass),
                                    });
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // STRATEGY 2.5: Look for class names followed by ANY bracket
    if (foundPlayers.length < 3) {
        for (let i = 0; i < lines.length; i++) {
            if (foundPlayers.length >= 3) break;
            const line = lines[i];
            if (/\bMAX\b/i.test(line)) continue;

            const flexMatch = line.match(
                /\b([A-Za-zÄÖÜäöü]{5,})\s*\[[^\]]{0,3}\]/i,
            );
            if (flexMatch) {
                const potentialClass = flexMatch[1];
                const matchedClass = matchClass(potentialClass);

                if (matchedClass) {
                    const classAlreadyFound = foundPlayers.some(
                        (p) => p.class.toLowerCase() === matchedClass.toLowerCase(),
                    );
                    if (classAlreadyFound) continue;

                    let foundName = null;
                    const beforeMatch = line.substring(
                        0,
                        line.indexOf(flexMatch[0]),
                    );

                    if (beforeMatch.trim()) {
                        const sameLine = beforeMatch
                            .replace(/[|:$#\[\]0-9]/g, " ")
                            .trim();
                        foundName = extractPlayerName(sameLine);
                        if (foundName && foundPlayers.some((p) => p.name === foundName)) {
                            foundName = null;
                        }
                    }

                    if (!foundName) {
                        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                            const name = extractPlayerName(lines[j]);
                            if (name && !foundPlayers.some((p) => p.name === name)) {
                                foundName = name;
                                break;
                            }
                        }
                    }

                    if (foundName) {
                        foundPlayers.push({
                            name: foundName,
                            class: formatClass(matchedClass),
                        });
                    }
                }
            }
        }
    }

    // STRATEGY 3: Fallback - look for standalone class names
    if (foundPlayers.length < 3) {
        for (let i = 0; i < lines.length; i++) {
            if (foundPlayers.length >= 3) break;
            const line = lines[i].trim();
            if (/\bMAX\b/i.test(line)) continue;

            const words = line.match(/[A-Za-zÄÖÜäöü]{5,}/g) || [];
            for (const word of words) {
                const matchedClass = matchClass(word);
                if (matchedClass) {
                    const classAlreadyFound = foundPlayers.some(
                        (p) => p.class.toLowerCase() === matchedClass.toLowerCase(),
                    );
                    if (classAlreadyFound) continue;

                    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                        const name = extractPlayerName(lines[j]);
                        if (name) {
                            const isDuplicate = foundPlayers.some(
                                (p) => p.name === name,
                            );
                            if (!isDuplicate) {
                                foundPlayers.push({
                                    name: name,
                                    class: formatClass(matchedClass),
                                });
                                break;
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    // STRATEGY 4: Handle "CLASS MAX" patterns
    if (foundPlayers.length < 3) {
        for (let i = 0; i < lines.length; i++) {
            if (foundPlayers.length >= 3) break;
            const line = lines[i].trim();
            const maxMatch = line.match(/\b([A-Za-z]{5,})\s+MAX\b/i);
            if (maxMatch) {
                const potentialClass = maxMatch[1];
                const matchedClass = matchClass(potentialClass);
                if (matchedClass) {
                    const classAlreadyFound = foundPlayers.some(
                        (p) => p.class.toLowerCase() === matchedClass.toLowerCase(),
                    );
                    if (classAlreadyFound) continue;

                    let foundName = null;
                    function isHighConfidenceName(name) {
                        if (!name) return false;
                        if (name.length >= 5) return true;
                        if (/^B[oö]rni$/i.test(name)) return true;
                        return false;
                    }

                    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
                        const candidateLine = lines[j];
                        if (
                            /^[\s\[\]\(\)\{\}|\\\/\-\.\,\;\:\#\@\!\?\*\&\%\$\=\+\<\>\~\`\'\"0-9]+$/.test(
                                candidateLine,
                            )
                        )
                            continue;

                        const name = extractPlayerName(candidateLine);
                        if (
                            isHighConfidenceName(name) &&
                            !foundPlayers.some((p) => p.name === name)
                        ) {
                            foundName = name;
                            break;
                        }
                    }

                    if (!foundName) {
                        for (
                            let j = i + 1;
                            j <= Math.min(lines.length - 1, i + 4);
                            j++
                        ) {
                            const candidateLine = lines[j];
                            if (
                                /^[\s\[\]\(\)\{\}|\\\/\-\.\,\;\:\#\@\!\?\*\&\%\$\=\+\<\>\~\`\'\"0-9]+$/.test(
                                    candidateLine,
                                )
                            )
                                continue;

                            const name = extractPlayerName(candidateLine);
                            if (
                                isHighConfidenceName(name) &&
                                !foundPlayers.some((p) => p.name === name)
                            ) {
                                foundName = name;
                                break;
                            }
                        }
                    }

                    foundPlayers.push({
                        name: foundName || "",
                        class: formatClass(matchedClass),
                    });
                }
            }
        }
    }

    // STRATEGY 5: Look for "Name\nCLASS" pattern in stats panel header
    if (foundPlayers.length < 3) {
        for (let i = 0; i < lines.length - 1; i++) {
            if (foundPlayers.length >= 3) break;
            const line = lines[i].trim();
            const nextLine = lines[i + 1].trim().toUpperCase();

            const matchedClass = matchClass(nextLine);
            if (matchedClass) {
                const classAlreadyFound = foundPlayers.some(
                    (p) => p.class.toLowerCase() === matchedClass.toLowerCase(),
                );
                if (classAlreadyFound) continue;

                const name = extractPlayerName(line);
                if (
                    name &&
                    name.length >= 3 &&
                    !foundPlayers.some((p) => p.name === name)
                ) {
                    foundPlayers.push({
                        name: name,
                        class: formatClass(matchedClass),
                    });
                }
            }
        }
    }

    // Assign players in DIRECT order (First detected = Player 1)
    // FIX: Removed .reverse() because OCR detects P1 first in your case
    for (let p = 0; p < foundPlayers.length && p < 3; p++) {
        const slot = p + 1;
        if (!pendingOCRResults[`p${slot}-name`]) {
            pendingOCRResults[`p${slot}-name`] = foundPlayers[p].name;
            pendingOCRResults[`p${slot}-class`] = foundPlayers[p].class;
        }
    }

    // === EXTRACT STATS ===
    function extractLastThreeNumbers(
        labelPatterns,
        excludeRegex = null,
        defaultToZero = false,
    ) {
        const patterns = Array.isArray(labelPatterns)
            ? labelPatterns
            : [labelPatterns];
        let labelFound = false;

        for (const labelRegex of patterns) {
            for (const line of lines) {
                const upperLine = line.toUpperCase();
                if (labelRegex.test(upperLine)) {
                    if (excludeRegex && excludeRegex.test(upperLine)) continue;
                    labelFound = true;
                    const nums = line.match(/\d+/g);
                    if (nums && nums.length >= 1) {
                        const lastNums = nums
                            .slice(-Math.min(3, nums.length))
                            .map((n) => parseInt(n));
                        if (
                            lastNums.every(
                                (n) => !isNaN(n) && n >= 0 && n < 1000000,
                            )
                        ) {
                            while (lastNums.length < 3) {
                                lastNums.push(null);
                            }
                            return lastNums;
                        }
                    }
                }
            }
        }
        if (labelFound && defaultToZero) {
            return [0, 0, 0];
        }
        return null;
    }

    function assignStats(nums, statName) {
        if (!nums) return;
        if (nums[0] !== null) pendingOCRResults[`p1-${statName}`] = nums[0];
        if (nums[1] !== null) pendingOCRResults[`p2-${statName}`] = nums[1];
        if (nums[2] !== null) pendingOCRResults[`p3-${statName}`] = nums[2];
    }

    // Kills
    const killsNums = extractLastThreeNumbers(
        [
            /\bKILLS\b/,
            /K[I1l]{1,2}[L1]{1,2}S/i,
            /KILLS/,
        ],
        /SPECIAL|SPECIA/i,
    );
    assignStats(killsNums, "kills");

    // Special Kills
    const specialNums = extractLastThreeNumbers([
        /SPECIAL\s*KILLS/,
        /SPEC[I1]AL\s*K[I1]LLS/i,
        /SPECIA.*KILLS/i,
    ]);
    assignStats(specialNums, "elite");

    // Incapacitations -> Death
    let incapNums = null;
    const incapPatterns = [/INCAPACITATION/i, /INCAP/i];
    for (const pattern of incapPatterns) {
        for (const line of lines) {
            if (pattern.test(line.toUpperCase())) {
                const fixedLine = line.replace(/\b[UO]\b/g, "0");
                const nums = fixedLine.match(/\d+/g);
                if (nums && nums.length >= 1) {
                    const lastNums = nums
                        .slice(-Math.min(3, nums.length))
                        .map((n) => parseInt(n));
                    if (lastNums.every((n) => !isNaN(n) && n >= 0 && n < 100)) {
                        while (lastNums.length < 3) lastNums.push(null);
                        incapNums = lastNums;
                        break;
                    }
                }
            }
        }
        if (incapNums) break;
    }
    assignStats(incapNums, "death");

    // Damage Taken
    const damageNums = extractLastThreeNumbers([
        /DAMAGE\s*TAKEN/,
        /DAMAGE.*TAKEN/i,
        /DAM.*TAK/i,
    ]);
    assignStats(damageNums, "damage");

    // Melee Damage
    const meleeNums = extractLastThreeNumbers([
        /MELEE\s*DAMAGE/i,
        /MELEE.*DAMAGE/i,
        /MELEE.*DAM/i,
    ]);
    assignStats(meleeNums, "melee");

    // Ranged Damage
    const rangedNums = extractLastThreeNumbers([
        /RANGED\s*DAMAGE/i,
        /RANGED.*DAMAGE/i,
        /RANGED.*DAM/i,
    ]);
    assignStats(rangedNums, "ranged");

    // Items Found
    const itemsNums = extractLastThreeNumbers([
        /ITEMS\s*FOUND/i,
        /ITEMS.*FOUND/i,
        /ITEM.*FOUND/i,
    ]);
    assignStats(itemsNums, "items");

    // Teammates Revived
    const revivedNums = extractLastThreeNumbers([
        /TEAMMATES\s*REVIVED/i,
        /TEAMMATE.*REVIVE/i,
        /TEAM.*REVIVE/i,
    ]);
    assignStats(revivedNums, "revived");

    // === WAVES (Siege Mode) ===
    const waveMatch = upperText.match(/STATUS\s*[:\-=]?\s*WAVE\s+(\d+)/i);
    if (waveMatch) {
        pendingOCRResults["global-waves"] = waveMatch[1];
    }

    // === ARMOURY DATA ===
    let armouryFound = false;
    const rewardsIdx = upperText.indexOf("REWARDS");
    if (rewardsIdx !== -1) {
        const afterRewards = text.substring(rewardsIdx, rewardsIdx + 150);
        const afterRewardsUpper = afterRewards.toUpperCase();
        const progressIdx = afterRewardsUpper.indexOf("CHARACTER");
        const cleanText =
            progressIdx > 0
                ? afterRewards.substring(0, progressIdx)
                : afterRewards;

        const tokens = cleanText
            .split(/[\r\n\t]+/)
            .map((t) => t.trim())
            .filter((t) => t);

        const numbersFound = [];
        for (const token of tokens) {
            const nums = token.match(/\d+/g);
            if (nums) {
                nums.forEach((n) => numbersFound.push(parseInt(n)));
            }
        }

        for (const num of numbersFound) {
            if (num >= 0 && num <= 3) {
                const hasRequisition = numbersFound.some(
                    (n) => n >= 100 && n <= 500,
                );
                if (hasRequisition || numbersFound.length >= 1) {
                    pendingOCRResults["global-armoury"] = num.toString();
                    armouryFound = true;
                    break;
                }
            }
        }

        if (!armouryFound) {
            const tabMatch = cleanText.match(/([0-3])[\t\s]+(\d{2,3})/);
            if (tabMatch && parseInt(tabMatch[2]) >= 100) {
                pendingOCRResults["global-armoury"] = tabMatch[1];
                armouryFound = true;
            }
        }
    }

    if (!armouryFound) {
        const armouryIdx = upperText.indexOf("ARMOURY");
        if (armouryIdx !== -1) {
            const nearArmoury = text.substring(
                Math.max(0, armouryIdx - 50),
                armouryIdx + 100,
            );
            const armouryMatch = nearArmoury.match(
                /([0-3])[\s\t]+(?:XP|\d{2,}|.*)/i,
            );
            if (armouryMatch) {
                pendingOCRResults["global-armoury"] = armouryMatch[1];
                armouryFound = true;
            }
        }
    }

    // === GENE-SEED DEFAULT ===
    if (!pendingOCRResults["global-geneseed"]) {
        const hasGeneseedMention = /GENE.?SEED|GENESEED/i.test(upperText);
        if (!hasGeneseedMention) {
            pendingOCRResults["global-geneseed"] = "0"; // No
        }
    }
}

// Show OCR review modal
function showOCRModal() {
    const modal = document.getElementById("ocr-modal-overlay");
    const grid = document.getElementById("ocr-detected-grid");
    const rawTextDiv = document.getElementById("ocr-raw-text");

    // Display raw text
    rawTextDiv.textContent = rawOCRText || "No text detected";

    // Helper to create input HTML
    function createInput(key, type, label) {
        const value = pendingOCRResults[key];
        // Explicitly handle 0 as a valid detected value (not missing)
        const hasValue =
            value !== undefined &&
            value !== null &&
            String(value) !== "";
        let displayValue = hasValue ? value : "";

        // Format special values
        if (key === "global-objective" && value === "1")
            displayValue = "Yes";
        if (key === "global-geneseed" && value === "1")
            displayValue = "Yes";
        if (key === "global-geneseed" && value === "0")
            displayValue = "No";

        let inputHTML = "";
        if (type === "difficulty") {
            inputHTML = `
                <select class="ocr-input ocr-select" data-key="${key}">
                    <option value="">- Select -</option>
                    <option value="Minimal" ${displayValue === "Minimal" ? "selected" : ""}>Minimal</option>
                    <option value="Average" ${displayValue === "Average" ? "selected" : ""}>Average</option>
                    <option value="Substantial" ${displayValue === "Substantial" ? "selected" : ""}>Substantial</option>
                    <option value="Ruthless" ${displayValue === "Ruthless" ? "selected" : ""}>Ruthless</option>
                    <option value="Lethal" ${displayValue === "Lethal" ? "selected" : ""}>Lethal</option>
                    <option value="Absolute" ${displayValue === "Absolute" ? "selected" : ""}>Absolute</option>
                    <option value="Normal" ${displayValue === "Normal" ? "selected" : ""}>Normal</option>
                    <option value="Hard" ${displayValue === "Hard" ? "selected" : ""}>Hard</option>
                </select>`;
        } else if (type === "class") {
            inputHTML = `
                <select class="ocr-input ocr-select" data-key="${key}">
                    <option value="">- Select -</option>
                    <option value="Tactical" ${displayValue === "Tactical" ? "selected" : ""}>Tactical</option>
                    <option value="Assault" ${displayValue === "Assault" ? "selected" : ""}>Assault</option>
                    <option value="Vanguard" ${displayValue === "Vanguard" ? "selected" : ""}>Vanguard</option>
                    <option value="Bulwark" ${displayValue === "Bulwark" ? "selected" : ""}>Bulwark</option>
                    <option value="Sniper" ${displayValue === "Sniper" ? "selected" : ""}>Sniper</option>
                    <option value="Heavy" ${displayValue === "Heavy" ? "selected" : ""}>Heavy</option>
                    <option value="Techmarine" ${displayValue === "Techmarine" ? "selected" : ""}>Techmarine</option>
                </select>`;
        } else if (type === "yesno") {
            const yesSelected =
                displayValue === "Yes" ? "selected" : "";
            const noSelected =
                displayValue === "No" || !hasValue
                    ? "selected"
                    : "";
            inputHTML = `
                <select class="ocr-input ocr-select" data-key="${key}">
                    <option value="0" ${noSelected}>No</option>
                    <option value="1" ${yesSelected}>Yes</option>
                </select>`;
        } else if (type === "armoury") {
            inputHTML = `
                <select class="ocr-input ocr-select" data-key="${key}">
                    <option value="0" ${displayValue === "0" ? "selected" : ""}>0</option>
                    <option value="1" ${displayValue === "1" ? "selected" : ""}>1</option>
                    <option value="2" ${displayValue === "2" ? "selected" : ""}>2</option>
                    <option value="3" ${displayValue === "3" ? "selected" : ""}>3</option>
                </select>`;
        } else if (type === "number") {
            inputHTML = `<input type="number" class="ocr-input" data-key="${key}" value="${displayValue}" min="0" placeholder="0">`;
        } else {
            inputHTML = `<input type="text" class="ocr-input" data-key="${key}" value="${displayValue}" placeholder="Not detected">`;
        }

        return `
            <div class="ocr-detected-item ${hasValue ? "" : "not-found"}">
                <span class="ocr-detected-label">${label}:</span>
                ${inputHTML}
            </div>
        `;
    }

    // Build grouped layout
    let gridHTML = "";

    // Mission Info Section
    gridHTML += `<div class="ocr-section"><div class="ocr-section-title">Mission Info</div>`;
    gridHTML += createInput("mission-name", "text", "Mission");
    gridHTML += createInput(
        "mission-difficulty",
        "difficulty",
        "Difficulty",
    );
    gridHTML += createInput(
        "global-objective",
        "yesno",
        "Objective Complete",
    );
    gridHTML += createInput(
        "global-geneseed",
        "yesno",
        "Geneseed Retrieved",
    );
    gridHTML += createInput(
        "global-armoury",
        "armoury",
        "Armoury Data",
    );
    gridHTML += createInput(
        "global-waves",
        "number",
        "Waves Reached",
    );
    // NEW
    gridHTML += createInput(
        "global-tasks",
        "number",
        "Tasks Completed"
    );
    gridHTML += `</div>`;

    // Space Marine sections
    for (let p = 1; p <= 3; p++) {
        gridHTML += `<div class="ocr-section ocr-player-section"><div class="ocr-section-title">Space Marine ${p}</div>`;
        gridHTML += createInput(`p${p}-name`, "text", "Name");
        gridHTML += createInput(`p${p}-class`, "class", "Class");
        gridHTML += `<div class="ocr-stats-row">`;
        gridHTML += createInput(`p${p}-kills`, "number", "Kills");
        gridHTML += createInput(
            `p${p}-elite`,
            "number",
            "Special Kills",
        );
        gridHTML += createInput(
            `p${p}-death`,
            "number",
            "Incapacitations",
        );
        gridHTML += createInput(
            `p${p}-damage`,
            "number",
            "Damage Taken",
        );
        gridHTML += `</div>`;
        gridHTML += `<div class="ocr-stats-row">`;
        gridHTML += createInput(
            `p${p}-melee`,
            "number",
            "Melee Damage",
        );
        gridHTML += createInput(
            `p${p}-ranged`,
            "number",
            "Ranged Damage",
        );
        gridHTML += createInput(
            `p${p}-items`,
            "number",
            "Items Found",
        );
        gridHTML += createInput(
            `p${p}-revived`,
            "number",
            "Revived",
        );
        gridHTML += `</div></div>`;
    }

    grid.innerHTML = gridHTML;

    // Show modal
    modal.classList.add("active");
}

// Apply OCR results to form
function applyOCRResults() {
    // Read values from the editable input fields in the modal
    const inputs = document.querySelectorAll(".ocr-input");
    inputs.forEach((input) => {
        const key = input.dataset.key;
        const value = input.value;
        const el = document.getElementById(key);
        if (el && value !== undefined && value !== "") {
            el.value = value;
        }
    });

    // Recalculate and save
    calculate();
    saveData();

    // Close modal
    closeOCRModal();

    // Update status
    const statusDiv = document.getElementById("upload-status");
    statusDiv.textContent = "Values applied successfully!";
    statusDiv.style.color = "#afffa6";
}

// Close OCR modal
function closeOCRModal() {
    const modal = document.getElementById("ocr-modal-overlay");
    modal.classList.remove("active");
}

// Export OCR debug data for troubleshooting
function exportOCRDebug() {
    // Get current version from header
    const headerDecor = document.querySelector(".header-decor");
    const versionText = headerDecor?.textContent || "";
    const versionMatch = versionText.match(/V\s*(\d+\.\d+\.\d+)/i);
    const currentVersion = versionMatch
        ? versionMatch[1]
        : "unknown";

    const debugData = {
        version: currentVersion,
        timestamp: new Date().toISOString(),
        detectedValues: pendingOCRResults,
        rawOCRText: rawOCRText,
    };

    // Create formatted debug output
    let output = "=== OCR DEBUG EXPORT ===\n";
    output += `Version: ${debugData.version}\n`;
    output += `Timestamp: ${debugData.timestamp}\n\n`;

    output += "=== DETECTED VALUES ===\n";
    for (const [key, value] of Object.entries(pendingOCRResults)) {
        output += `${key}: ${value}\n`;
    }

    output += "\n=== RAW OCR TEXT ===\n";
    output += rawOCRText;

    output += "\n\n=== ANALYSIS ===\n";
    // Check what lines contain stats keywords
    const lines = rawOCRText.split(/[\r\n]+/);
    output += "Lines containing 'KILL' (case-insensitive):\n";
    lines.forEach((line, i) => {
        if (/kill/i.test(line)) {
            output += `  Line ${i}: ${line}\n`;
            // Show what numbers were found
            const nums = line.match(/\d+/g);
            output += `    Numbers found: ${nums ? nums.join(", ") : "NONE"}\n`;
        }
    });

    output += "\nLines containing 'INCAP' (case-insensitive):\n";
    lines.forEach((line, i) => {
        if (/incap/i.test(line)) {
            output += `  Line ${i}: ${line}\n`;
            const nums = line.match(/\d+/g);
            output += `    Numbers found: ${nums ? nums.join(", ") : "NONE"}\n`;
        }
    });

    output += "\nLines containing 'DAMAGE' (case-insensitive):\n";
    lines.forEach((line, i) => {
        if (/damage/i.test(line)) {
            output += `  Line ${i}: ${line}\n`;
            const nums = line.match(/\d+/g);
            output += `    Numbers found: ${nums ? nums.join(", ") : "NONE"}\n`;
        }
    });

    // Download the file
    const blob = new Blob([output], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ocr_debug_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Clear all data except modifiers
function clearData() {
    if (
        !confirm("Clear all mission data? (Modifiers will be kept)")
    ) {
        return;
    }

    // List of fields to clear (everything except modifiers)
    const fieldsToClear = [
        "mission-name",
        "mission-difficulty",
        "global-objective",
        "global-geneseed",
        "global-armoury",
        "global-waves",
        "p1-name",
        "p2-name",
        "p3-name",
        "p1-class",
        "p2-class",
        "p3-class",
        "p1-kills",
        "p2-kills",
        "p3-kills",
        "p1-elite",
        "p2-elite",
        "p3-elite",
        "p1-death",
        "p2-death",
        "p3-death",
        "p1-damage",
        "p2-damage",
        "p3-damage",
        "p1-melee",
        "p2-melee",
        "p3-melee",
        "p1-ranged",
        "p2-ranged",
        "p3-ranged",
        "p1-items",
        "p2-items",
        "p3-items",
        "p1-revived",
        "p2-revived",
        "p3-revived",
    ];

    fieldsToClear.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            if (el.tagName === "SELECT") {
                el.selectedIndex = 0;
            } else if (el.type === "number") {
                el.value = 0;
                el.setAttribute("value", "0");
            } else {
                el.value = "";
            }
            el.dispatchEvent(
                new Event("change", { bubbles: true }),
            );
        }
    });

    // Also update Additional Stats headers
    updateAdditionalStatsHeaders();

    // Recalculate and save
    calculate();
    saveData();
}

const STORAGE_KEY = "missionDebriefData";

// List of all input/select IDs to save
const inputIds = [
    "mod-kills",
    "mod-elite",
    "mod-death",
    "mod-damage",
    "mod-gene",
    "mod-armoury",
    "mod-obj",
    "mod-waves", // Existing
    "mod-tasks", // NEW
    "mission-name",
    "mission-difficulty",
    "global-objective",
    "global-geneseed",
    "global-armoury",
    "global-waves", // Existing
    "global-tasks", // NEW
    "p1-name", "p2-name", "p3-name",
    "p1-class", "p2-class", "p3-class",
    "p1-kills", "p2-kills", "p3-kills",
    "p1-elite", "p2-elite", "p3-elite",
    "p1-death", "p2-death", "p3-death",
    "p1-damage", "p2-damage", "p3-damage",
    "p1-items", "p2-items", "p3-items",
    "p1-revived", "p2-revived", "p3-revived",
    "p1-melee", "p2-melee", "p3-melee",
    "p1-ranged", "p2-ranged", "p3-ranged"
];

// Save all form data to localStorage
function saveData() {
    const data = {};
    inputIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            data[id] = el.value;
        }
    });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn("Could not save to localStorage:", e);
    }
}

// Load all form data from localStorage
function loadData() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            inputIds.forEach((id) => {
                const el = document.getElementById(id);
                if (
                    el &&
                    data[id] !== undefined &&
                    data[id] !== ""
                ) {
                    el.value = data[id];
                }
            });
        }
    } catch (e) {
        console.warn("Could not load from localStorage:", e);
    }
}

// Helper to get float value from input ID, defaults to 0
function getVal(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    const val = parseFloat(el.value);
    return isNaN(val) ? 0 : val;
}
// Helper to get string value from input ID, defaults to empty
function getStr(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
}

// Helper to set text content of element
function setTxt(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
}

// Update Additional Stats headers with player names from Squad Matrix
function updateAdditionalStatsHeaders() {
    for (let i = 1; i <= 3; i++) {
        const nameInput = document.getElementById(`p${i}-name`);
        const header = document.getElementById(
            `addstats-p${i}-header`,
        );
        if (header && nameInput) {
            const name = nameInput.value.trim();
            header.textContent = name || `Battle Brother ${i}`;
        }
    }
}

function calculate() {
    // 1. Get Modifiers
    const modKills = getVal("mod-kills");
    const modElite = getVal("mod-elite");
    const modDeath = getVal("mod-death");
    const modDamage = getVal("mod-damage");
    const modGene = getVal("mod-gene");
    const modArmoury = getVal("mod-armoury");
    const modObj = getVal("mod-obj");
    
    // NEW: Logic for specific Wave/Task values
    // NOTE: In your HTML, set the default value of 'mod-waves' to 250
    // and 'mod-tasks' to 25 to match your new rules.
    const modWaves = getVal("mod-waves"); 
    const modTasks = getVal("mod-tasks"); 

    // 2. Get Global statuses
    const globalObj = document.getElementById("global-objective").value === "" ? 0 : getVal("global-objective");
    const globalGene = document.getElementById("global-geneseed").value === "" ? 0 : getVal("global-geneseed");
    const globalArmoury = document.getElementById("global-armoury").value === "" ? 0 : getVal("global-armoury");
    
    const globalWaves = getVal("global-waves");
    const globalTasks = getVal("global-tasks"); // NEW

    // --- NEW LOGIC CALCULATION ---
    
    // Wave Bonus: Only applies to waves > 15
    let waveScore = 0;
    if (globalWaves > 15) {
        waveScore = (globalWaves - 15) * modWaves;
    }

    // Task Bonus: Simple multiplication
    let taskScore = globalTasks * modTasks;

    // Initialize Total Accumulators
    let sumKills = 0; let sumElite = 0; let sumDeath = 0;
    let sumDamage = 0; let sumMelee = 0; let sumRanged = 0;
    let sumItems = 0; let sumRevived = 0;

    // --- Calculate for each player ---
    for (let i = 1; i <= 3; i++) {
        // Player Inputs
        const kills = getVal(`p${i}-kills`);
        const elite = getVal(`p${i}-elite`);
        const death = getVal(`p${i}-death`);
        const damage = getVal(`p${i}-damage`);
        const melee = getVal(`p${i}-melee`);
        const ranged = getVal(`p${i}-ranged`);
        const items = getVal(`p${i}-items`);
        const revived = getVal(`p${i}-revived`);

        // Accumulate
        sumKills += kills; sumElite += elite; sumDeath += death;
        sumDamage += damage; sumMelee += melee; sumRanged += ranged;
        sumItems += items; sumRevived += revived;

        // Base Score
        const playerBaseScore =
            kills * modKills +
            elite * modElite +
            globalObj * modObj;

        // Modifier Score (Now includes the new Wave Logic + Tasks)
        const playerModifierScore =
            death * modDeath +
            damage * modDamage +
            globalGene * modGene +
            globalArmoury * modArmoury +
            waveScore +  // Added calculated wave score
            taskScore;   // Added calculated task score

        // Final Score
        const playerFinalScore = Math.round(playerBaseScore + playerModifierScore);

        // Update DOM
        setTxt(`p${i}-base`, Math.round(playerBaseScore * 10) / 10);
        setTxt(`p${i}-mod`, parseFloat(playerModifierScore.toFixed(1)));
        setTxt(`p${i}-final`, playerFinalScore);

        // Differential
        const diff = revived - death;
        const diffEl = document.getElementById(`p${i}-diff`);
        if (diffEl) {
            diffEl.textContent = `(${diff >= 0 ? "+" : ""}${diff})`;
            diffEl.style.color = diff >= 0 ? "#afffa6" : "#ff6600";
        }
    }

    // --- Totals ---
    setTxt("total-kills", sumKills); setTxt("total-elite", sumElite);
    setTxt("total-death", sumDeath); setTxt("total-damage", sumDamage);
    setTxt("total-melee", sumMelee); setTxt("total-ranged", sumRanged);
    setTxt("total-items", sumItems); setTxt("total-revived", sumRevived);

    updateAdditionalStatsHeaders();

    const totalDiff = sumRevived - sumDeath;
    const totalDiffEl = document.getElementById("total-diff");
    if (totalDiffEl) {
        totalDiffEl.textContent = `(${totalDiff >= 0 ? "+" : ""}${totalDiff})`;
        totalDiffEl.style.color = totalDiff >= 0 ? "#afffa6" : "#ff6600";
    }

    // Squad Base Score
    const totalSquadBaseScore =
        sumKills * modKills +
        sumElite * modElite +
        globalObj * modObj;

    // Squad Modifier Score (New Logic)
    const totalSquadModifierScore =
        sumDeath * modDeath +
        sumDamage * modDamage +
        globalGene * modGene +
        globalArmoury * modArmoury +
        waveScore + 
        taskScore;

    const totalSquadFinalScore = Math.round(totalSquadBaseScore + totalSquadModifierScore);

    setTxt("total-base", Math.round(totalSquadBaseScore * 10) / 10);
    setTxt("total-mod", parseFloat(totalSquadModifierScore.toFixed(1)));
    setTxt("total-final", totalSquadFinalScore);
}

/* --- NEW DATA BANK SYSTEM --- */

// 1. Generate CSV Content (Returns String)
function generateCSVString() {
    const missionName = getStr("mission-name");
    const missionDifficulty = document.getElementById("mission-difficulty").value;
    
    // Get player names
    const p1Name = getStr("p1-name") || "Battle Brother 1";
    const p2Name = getStr("p2-name") || "Battle Brother 2";
    const p3Name = getStr("p3-name") || "Battle Brother 3";

    const csv = [];

    // MISSION PARAMETERS
    csv.push("MISSION PARAMETERS");
    csv.push(`Mission Played:,${getStr("mission-name")}`);
    csv.push(`Difficulty:,${missionDifficulty}`);
    csv.push(`Waves Reached:,${getVal("global-waves")}`);
    csv.push(`Tasks Completed:,${getVal("global-tasks")}`); // NEW LINE
    csv.push(`Objective Completion:,${document.getElementById("global-objective").value === "1" ? "Yes" : "No"}`);
    csv.push(`Geneseed Retrieved:,${document.getElementById("global-geneseed").value === "1" ? "Yes" : "No"}`);
    csv.push(`Armoury Data Retrieved:,${getVal("global-armoury")}`);
    csv.push("");

    // MODIFIERS
    csv.push("MODIFIERS");
    csv.push(`Kills:,${getVal("mod-kills")}`);
    csv.push(`Special Kills:,${getVal("mod-elite")}`);
    csv.push(`Incapacitations:,${getVal("mod-death")}`);
    csv.push(`Damage Taken:,${getVal("mod-damage")}`);
    csv.push(`Geneseed:,${getVal("mod-gene")}`);
    csv.push(`Armoury:,${getVal("mod-armoury")}`);
    csv.push(`Objective:,${getVal("mod-obj")}`);
    csv.push(`Waves:,${getVal("mod-waves")}`);
    csv.push(`Tasks:,${getVal("mod-tasks")}`); // NEW LINE
    csv.push("");

    // SQUAD PERFORMANCE MATRIX
    csv.push("SQUAD PERFORMANCE MATRIX");
    csv.push(`,${p1Name},${p2Name},${p3Name},TOTAL`);
    csv.push(`Class,${document.getElementById("p1-class").value},${document.getElementById("p2-class").value},${document.getElementById("p3-class").value},`);
    csv.push(`Kills,${getVal("p1-kills")},${getVal("p2-kills")},${getVal("p3-kills")},${document.getElementById("total-kills").textContent}`);
    csv.push(`Special Kills,${getVal("p1-elite")},${getVal("p2-elite")},${getVal("p3-elite")},${document.getElementById("total-elite").textContent}`);
    csv.push(`Incapacitations,${getVal("p1-death")},${getVal("p2-death")},${getVal("p3-death")},${document.getElementById("total-death").textContent}`);
    csv.push(`Damage Taken,${getVal("p1-damage")},${getVal("p2-damage")},${getVal("p3-damage")},${document.getElementById("total-damage").textContent}`);
    csv.push(`Base Score,${document.getElementById("p1-base").textContent},${document.getElementById("p2-base").textContent},${document.getElementById("p3-base").textContent},${document.getElementById("total-base").textContent}`);
    csv.push(`Modifier Score,${document.getElementById("p1-mod").textContent},${document.getElementById("p2-mod").textContent},${document.getElementById("p3-mod").textContent},${document.getElementById("total-mod").textContent}`);
    csv.push(`TOTAL SCORE,${document.getElementById("p1-final").textContent},${document.getElementById("p2-final").textContent},${document.getElementById("p3-final").textContent},${document.getElementById("total-final").textContent}`);
    csv.push("");

    // ADDITIONAL STATISTICS
    csv.push("ADDITIONAL STATISTICS");
    csv.push(`,${p1Name},${p2Name},${p3Name},TOTAL`);
    csv.push(`Melee Damage,${getVal("p1-melee")},${getVal("p2-melee")},${getVal("p3-melee")},${document.getElementById("total-melee").textContent}`);
    csv.push(`Ranged Damage,${getVal("p1-ranged")},${getVal("p2-ranged")},${getVal("p3-ranged")},${document.getElementById("total-ranged").textContent}`);
    csv.push(`Items Found,${getVal("p1-items")},${getVal("p2-items")},${getVal("p3-items")},${document.getElementById("total-items").textContent}`);

    // Teammates Revived logic
    const p1Revived = getVal("p1-revived");
    const p2Revived = getVal("p2-revived");
    const p3Revived = getVal("p3-revived");
    const p1Deaths = getVal("p1-death");
    const p2Deaths = getVal("p2-death");
    const p3Deaths = getVal("p3-death");
    const p1Diff = p1Revived - p1Deaths;
    const p2Diff = p2Revived - p2Deaths;
    const p3Diff = p3Revived - p3Deaths;
    const totalRevived = p1Revived + p2Revived + p3Revived;
    const totalDeaths = p1Deaths + p2Deaths + p3Deaths;
    const totalDiff = totalRevived - totalDeaths;
    csv.push(`Teammates Revived,${p1Revived} (${p1Diff >= 0 ? "+" : ""}${p1Diff}),${p2Revived} (${p2Diff >= 0 ? "+" : ""}${p2Diff}),${p3Revived} (${p3Diff >= 0 ? "+" : ""}${p3Diff}),${totalRevived} (${totalDiff >= 0 ? "+" : ""}${totalDiff})`);

    return csv.join("\n");
}

// 2. Save Mission to Internal Storage
function saveMissionInternal() {
    // Get existing data
    let savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");

    if (savedSlots.length >= 3) {
        alert("Memory Banks Full! Delete a Data Slate to make room.");
        return;
    }

    const csvContent = generateCSVString();
    const missionName = getStr("mission-name") || "Unknown Mission";
    const difficulty = document.getElementById("mission-difficulty").value || "Unknown";
    
    // Create slot object
    const newSlot = {
        id: Date.now(),
        name: missionName,
        difficulty: difficulty,
        csv: csvContent,
        timestamp: new Date().toLocaleTimeString()
    };

    savedSlots.push(newSlot);
    localStorage.setItem("cogitator_saved_missions", JSON.stringify(savedSlots));
    
    renderDataBankUI();
    // Alert removed for smoother workflow
}

// 3. Render the UI slots (Top Section)
function renderDataBankUI() {
    const container = document.getElementById("data-bank-ui");
    const savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");
    
    // Update the counter in the bottom section too
    const counterEl = document.getElementById("slots-count-display");
    if(counterEl) counterEl.textContent = `${savedSlots.length}/3`;

    container.innerHTML = "";

    // Create 3 slots (occupied or empty)
    for (let i = 0; i < 3; i++) {
        const slotData = savedSlots[i];
        const slotEl = document.createElement("div");
        
        if (slotData) {
            slotEl.className = `data-slot occupied`;
            slotEl.style.cursor = "pointer"; // Visual cue that it's clickable
            
            // CLICK HANDLER: Opens the overlay
            slotEl.onclick = function() { openSlotOverlay(i); };

            slotEl.innerHTML = `
                <span class="slot-name">${i+1}. ${slotData.name}</span>
                <span style="font-size: 0.8em; opacity: 0.7; margin-left: 10px;">[${slotData.difficulty}]</span>
                <button class="delete-slot-btn" onclick="event.stopPropagation(); deleteSlot(${i})">X</button>
            `;
        } else {
            slotEl.className = `data-slot`;
            slotEl.innerHTML = `<span class="slot-name" style="opacity:0.5;">[ EMPTY SLOT ]</span>`;
        }
        container.appendChild(slotEl);
    }
}

/* === HELPER: Convert CSV Section to HTML Table === */
function csvToHtmlTable(csvText, sectionTitle) {
    const lines = csvText.split('\n');
    const startIdx = lines.findIndex(line => line.includes(sectionTitle));
    
    if (startIdx === -1) return `<p>Data not found for ${sectionTitle}</p>`;

    let html = '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-family: \'VT323\', monospace;">';
    
    // Process Header (Line immediately after title)
    // The CSV Header looks like: ,Player1,Player2,Player3,TOTAL
    const headerLine = lines[startIdx + 1];
    if (headerLine) {
        const headers = headerLine.split(',');
        html += '<thead style="color: var(--pip-green); border-bottom: 1px solid var(--pip-green);">';
        html += '<tr>';
        // First column is usually empty in CSV, label it "METRIC"
        html += `<th style="text-align: left; padding: 5px;">METRIC</th>`;
        // Rest of the headers (Players + Total)
        for (let i = 1; i < headers.length; i++) {
            html += `<th style="text-align: center; padding: 5px;">${headers[i].trim()}</th>`;
        }
        html += '</tr></thead>';
    }

    // Process Body
    html += '<tbody>';
    for (let i = startIdx + 2; i < lines.length; i++) {
        const line = lines[i].trim();
        // Stop if we hit an empty line or the start of a new section
        if (!line || line === "ADDITIONAL STATISTICS" || line === "MODIFIERS") break;

        const cols = line.split(',');
        html += '<tr style="border-bottom: 1px solid #333;">';
        
        // Metric Name (First Column) - Align Left
        html += `<td style="text-align: left; padding: 5px; color: #aaa;">${cols[0].trim()}</td>`;
        
        // Data Columns - Align Center
        for (let j = 1; j < cols.length; j++) {
            // Highlight the TOTAL column (last one) slightly
            const isTotal = j === cols.length - 1;
            const style = isTotal ? "color: #fff; font-weight: bold;" : "color: #afffa6;";
            html += `<td style="text-align: center; padding: 5px; ${style}">${cols[j].trim()}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    
    return html;
}

/* === UPDATED: OVERLAY SYSTEM (With Download Button) === */
function openSlotOverlay(index) {
    const savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");
    const slot = savedSlots[index];
    if(!slot) return;

    // Create modal element if it doesn't exist yet
    let modal = document.getElementById('slot-modal-overlay');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'slot-modal-overlay';
        modal.className = 'ocr-modal-overlay'; 
        document.body.appendChild(modal);
    }

    // Generate Tables
    const matrixTable = csvToHtmlTable(slot.csv, "SQUAD PERFORMANCE MATRIX");
    const statsTable = csvToHtmlTable(slot.csv, "ADDITIONAL STATISTICS");

    // Build Modal Content
    modal.innerHTML = `
        <div class="ocr-modal-content" style="
            max-width: 900px; 
            width: 95%; 
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            border: 2px solid var(--pip-green); 
            background: #050a05; 
            box-shadow: 0 0 20px rgba(51, 255, 0, 0.2); 
            overflow: hidden; 
            padding: 0; 
        ">
            
            <div style="
                overflow-y: auto;
                width: 100%;
                height: 100%;
                padding: 30px 60px 30px 30px; 
                box-sizing: border-box;
            ">
                
                <div style="text-align: center; border-bottom: 1px solid var(--pip-green); padding-bottom: 15px; margin-bottom: 20px;">
                    <h2 style="color: var(--pip-green); margin: 0; font-size: 2em; letter-spacing: 2px;">${slot.name.toUpperCase()}</h2>
                    
                    <div style="margin-top: 5px; font-size: 0.9em; color: #afffa6; opacity: 0.6; font-family: 'VT323', monospace;">
                        Difficulty: ${slot.difficulty}
                    </div>
                </div>

                <h3 style="color: var(--pip-green); margin-top: 0; font-size: 1.1em; opacity: 0.8;">SQUAD PERFORMANCE MATRIX</h3>
                ${matrixTable}

                <h3 style="color: var(--pip-green); margin-top: 20px; font-size: 1.1em; opacity: 0.8;">ADDITIONAL STATISTICS</h3>
                ${statsTable}

                <div style="
                    display: flex; 
                    justify-content: flex-end; 
                    gap: 15px; 
                    margin-top: 30px; 
                    padding-top: 15px; 
                    border-top: 1px solid #333;
                ">
                    <button onclick="downloadSlotCSV(${index})" class="ocr-btn" style="
                        width: auto; 
                        padding: 5px 20px; 
                        background: rgba(0, 50, 0, 0.5); 
                        border: 1px solid #558855; 
                        color: #afffa6;
                        font-size: 0.9em;
                    ">DOWNLOAD CSV</button>
                    
                    <button onclick="closeSlotModal()" class="ocr-btn" style="
                        width: auto; 
                        padding: 5px 30px;
                    ">CLOSE</button>
                </div>

            </div>
        </div>
    `;

    requestAnimationFrame(() => modal.classList.add('active'));
}

function closeSlotModal() {
    const modal = document.getElementById('slot-modal-overlay');
    if (modal) modal.classList.remove('active');
}

/* === HELPER: Download Slot Data as CSV === */
function downloadSlotCSV(index) {
    const savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");
    const slot = savedSlots[index];
    if(!slot) return;

    // Create a Blob from the CSV string
    const blob = new Blob([slot.csv], { type: 'text/csv;charset=utf-8;' });
    
    // Generate a filename based on Mission Name and Date
    const safeName = slot.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `mission_data_${safeName}_${index+1}.csv`;

    // Trigger Download
    const link = document.createElement("a");
    if (link.download !== undefined) { 
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// 4. Delete a Slot
function deleteSlot(index) {
    if(!confirm("Purge this Data Slate from memory?")) return;
    
    let savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");
    savedSlots.splice(index, 1); // Remove at index
    localStorage.setItem("cogitator_saved_missions", JSON.stringify(savedSlots));
    renderDataBankUI();
}

// 5. Aggregate Data (Self-Repairing Version)
function aggregateInternalData() {
    const statusEl = document.getElementById('import-status');
    let savedSlots = [];
    
    try {
        savedSlots = JSON.parse(localStorage.getItem("cogitator_saved_missions") || "[]");
    } catch (e) {
        // If JSON is broken, wipe it
        localStorage.removeItem("cogitator_saved_missions");
        statusEl.textContent = "MEMORY CORRUPTION DETECTED. BANKS PURGED.";
        statusEl.style.color = "#ff5555";
        return;
    }

    if (savedSlots.length === 0) {
        statusEl.textContent = "NO DATA SLATES FOUND IN MEMORY";
        statusEl.style.color = "#ff5555";
        return;
    }

    // Reset Global State
    importAppState = {
        mission: { name:'-', diff:'-', waves:'-', obj:'-', gene:'-', arm:'-' },
        modifiers: { kills:'-', specials:'-', incaps:'-', dmg:'-', gene:'-', arm:'-', obj:'-', waves:'-' },
        players: {},      
        playerOrder: [],  
        matrixTotals: {}  
    };

    let successCount = 0;
    let corruptedCount = 0;

    // Process each slot safely
    const cleanSlots = [];
    
    savedSlots.forEach((slot, index) => {
        try {
            // Validation: Must have CSV string
            if (!slot.csv || typeof slot.csv !== 'string') {
                throw new Error("Invalid Format");
            }
            
            // Check if processCSV exists (critical check)
            if (typeof processCSV !== "function") {
                throw new Error("processCSV function missing. Logic not loaded.");
            }

            processCSV(slot.csv);
            cleanSlots.push(slot); // Keep good slots
            successCount++;
            
        } catch (err) {
            console.error(`Slot ${index+1} Corrupted:`, err);
            corruptedCount++;
        }
    });

    // Save back only the clean slots (Auto-Repair)
    if (corruptedCount > 0) {
        localStorage.setItem("cogitator_saved_missions", JSON.stringify(cleanSlots));
        renderDataBankUI(); // Refresh UI to remove bad slots
    }

    renderImportUI();
    
    // Status Message
    if (successCount > 0) {
        statusEl.textContent = `AGGREGATED ${successCount} SLATES` + (corruptedCount ? ` (${corruptedCount} PURGED)` : "");
        statusEl.style.color = "var(--pip-green)";
        document.getElementById('results-container').scrollIntoView({ behavior: 'smooth' });
    } else {
        statusEl.textContent = "ALL SLATES WERE CORRUPTED AND PURGED.";
        statusEl.style.color = "#ff5555";
    }
}


// PNG Export of Aggregated Data Screen
async function saveAsPNG() {
    // 1. Identify the button (for visual feedback)
    // We try to find the button calling this function, or fallback to a likely ID
    const btn = document.querySelector('button[onclick="saveAsPNG()"]') || 
                document.getElementById('export-png-btn'); 
    
    const originalText = btn ? btn.innerText : "";
    if (btn) btn.innerText = "CAPTURING...";

    // 2. Select Elements
    const frame = document.querySelector(".cogitator-frame");
    const buttonsContainer = document.querySelector(".export-buttons-container");
    const topWrapper = document.getElementById("top-wrapper");
    const importWrapper = document.getElementById("import-wrapper");

    // 3. Save Original Styles
    const originalTopDisplay = topWrapper ? topWrapper.style.display : "";
    const originalButtonsDisplay = buttonsContainer.style.display;
    const originalFrameWidth = frame.style.width;
    const originalFrameMaxWidth = frame.style.maxWidth;
    const originalBodyWidth = document.body.style.width;
    const originalFrameHeight = frame.style.height;

    try {
        // 4. Hide Top, Show Bottom
        if (topWrapper) topWrapper.style.display = "none";
        if (importWrapper) importWrapper.style.display = "block";
        buttonsContainer.style.display = "none";

        // 5. Force Desktop Layout & Tight Height
        document.body.style.width = "1120px";
        frame.style.width = "1100px";
        frame.style.maxWidth = "none";
        frame.style.height = "max-content"; // Shrink frame to fit content

        // Wait for layout to settle
        await new Promise(resolve => setTimeout(resolve, 100));

        // 6. Capture
        const canvas = await html2canvas(frame, {
            scale: 2,
            backgroundColor: "#000",
            windowWidth: 1280,
            useCORS: true
        });

        // 7. Download
        const link = document.createElement("a");
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        link.download = `Import_Data_${timestamp}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();

    } catch (err) {
        console.error("PNG export failed:", err);
        alert("Failed to capture screenshot.");
    } finally {
        // 8. Restore Everything
        if (topWrapper) topWrapper.style.display = originalTopDisplay;
        buttonsContainer.style.display = originalButtonsDisplay;
        
        frame.style.width = originalFrameWidth;
        frame.style.maxWidth = originalFrameMaxWidth;
        frame.style.height = originalFrameHeight;
        document.body.style.width = originalBodyWidth;
        
        if (btn) btn.innerText = originalText;
    }
}

// Initialize: load saved data and calculate when DOM is ready
document.addEventListener("DOMContentLoaded", function () {
    loadData();
    calculate();
    renderDataBankUI();
});

// Service Worker Registration
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("./service-worker.js")
            .then((registration) => {
                console.log(
                    "Service Worker registered! Scope:",
                    registration.scope,
                );
            })
            .catch((err) => {
                console.log(
                    "Service Worker registration failed:",
                    err,
                );
            });
    });
}

// --- LOGIC FOR DATA IMPORT SECTION (FROM Result Calculator V1.8) ---

let importAppState = {
    mission: { name:'-', diff:'-', waves:'-', obj:'-', gene:'-', arm:'-' },
    modifiers: { kills:'-', specials:'-', incaps:'-', dmg:'-', gene:'-', arm:'-', obj:'-', waves:'-' },
    players: {},      
    playerOrder: [],  
    matrixTotals: {}  
};

const MATRIX_KEYS = [
    "Kills", "Special Kills", "Incapacitations", 
    "Damage Taken", "Base Score", "Modifier Score", "TOTAL SCORE"
];

const ADD_STATS_KEYS = [
    "Melee Damage", "Ranged Damage", "Items Found", "Teammates Revived"
];

/* --- SAFE CSV UPLOAD LISTENER --- */
const csvUploadInput = document.getElementById('csv-upload');

if (csvUploadInput) {
    csvUploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files).slice(0, 3);
        if(!files.length) return;

        // Reset State
        importAppState = {
            mission: { name:'-', diff:'-', waves:'-', obj:'-', gene:'-', arm:'-' },
            modifiers: { kills:'-', specials:'-', incaps:'-', dmg:'-', gene:'-', arm:'-', obj:'-', waves:'-', tasks:'-' },
            players: {},
            playerOrder: [],  
            matrixTotals: {}  
        };

        try {
            for(const file of files) {
                const text = await file.text();
                processCSV(text);
            }
            renderImportUI();
            const statusEl = document.getElementById('import-status');
            statusEl.textContent = `PROCESSED ${files.length} FILES SUCCESSFULLY`;
            statusEl.style.color = "var(--pip-green)";
        } catch(err) {
            console.error(err);
            const statusEl = document.getElementById('import-status');
            statusEl.textContent = "ERROR READING FILES";
            statusEl.style.color = "#ff5555";
        }
    });
}

/* --- FIXED: Reset/Purge Aggregated Data + Clear Memory --- */
function resetImport() {
    // 1. Safety Check: Confirm before wiping
    if (!confirm("WARNING: This will purge ALL aggregated data and wipe the internal memory banks. \n\nAre you sure you want to proceed?")) {
        return;
    }

    // 2. Clear file input
    const fileInput = document.getElementById('csv-upload');
    if (fileInput) fileInput.value = "";

    // 3. Hide Results
    const results = document.getElementById('results-container');
    if (results) results.classList.remove('visible');

    // 4. Clear Status
    const status = document.getElementById('import-status');
    if (status) status.textContent = "MEMORY BANKS FLUSHED.";

    // 5. Reset State
    importAppState = {
        mission: { name:'-', diff:'-', waves:'-', obj:'-', gene:'-', arm:'-' },
        modifiers: { kills:'-', specials:'-', incaps:'-', dmg:'-', gene:'-', arm:'-', obj:'-', waves:'-' },
        players: {},      
        playerOrder: [],  
        matrixTotals: {}  
    };
    
    // 6. NUCLEAR OPTION: Wipe the saved missions too
    localStorage.removeItem("cogitator_saved_missions");
    renderDataBankUI(); // Update the green slots to show they are empty
    
    console.log("Aggregated data purged.");
}

/* --- RESTORED: Missing Helper Function --- */
function parseCSVRow(rowStr) {
    const res = [];
    let cur = '';
    let inQ = false;
    for(let c of rowStr){
        if(c === '"'){ inQ = !inQ; continue; }
        if(c === ',' && !inQ){ res.push(cur.trim()); cur = ''; } else cur += c;
    }
    res.push(cur.trim());
    return res;
}

function processCSV(text) {
    const lines = text.split(/\r?\n/);
    
    for(let i=0; i < Math.min(lines.length, 60); i++) {
        const line = lines[i].trim();
        if(!line) continue;

        const matchVal = (regex) => {
            const m = line.match(regex);
            return m ? m[1].replace(/,/g, '').trim() : null;
        };

        if(importAppState.mission.name === '-') importAppState.mission.name = matchVal(/^[, \t]*Mission Played[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.diff === '-') importAppState.mission.diff = matchVal(/^[, \t]*Difficulty[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.obj === '-') importAppState.mission.obj = matchVal(/^[, \t]*Objective Completion[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.gene === '-') importAppState.mission.gene = matchVal(/^[, \t]*Geneseed Retrieved[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.arm === '-') importAppState.mission.arm = matchVal(/^[, \t]*Armoury Data Retrieved[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.waves === '-') importAppState.mission.waves = matchVal(/^[, \t]*Waves Reached[:,\s]+(.+)/i) || '-';
        if(importAppState.mission.tasks === '-') importAppState.mission.tasks = matchVal(/^[, \t]*Tasks Completed[:,\s]+(.+)/i) || '-';

        if(line.includes(':,')) {
            const parts = line.split(':,');
            if(parts.length >= 2) {
                const key = parts[0].trim();
                const val = parts[1].split(',')[0].trim(); 

                if(key === 'Kills') importAppState.modifiers.kills = val;
                if(key === 'Special Kills') importAppState.modifiers.specials = val;
                if(key === 'Incapacitations') importAppState.modifiers.incaps = val;
                if(key === 'Damage Taken') importAppState.modifiers.dmg = val;
                if(key === 'Geneseed') importAppState.modifiers.gene = val;
                if(key === 'Armoury') importAppState.modifiers.arm = val;
                if(key === 'Waves') importAppState.modifiers.waves = val;
                if(key === 'Objective') importAppState.modifiers.obj = val;
                if(key === 'Tasks') importAppState.modifiers.tasks = val;
            }
        }
    }

    const parseSection = (sectionName, keysToExtract) => {
        const idx = lines.findIndex(l => l.toUpperCase().includes(sectionName));
        if(idx === -1) return;

        const header = parseCSVRow(lines[idx + 1]);
        const colMap = {};
        let totalColIdx = -1;

        header.forEach((h, col) => {
            const hh = h.toUpperCase().trim();
            if(hh === 'TOTAL') totalColIdx = col;
            else if(hh.length > 0) {
                colMap[col] = h.trim();
                const pName = h.trim();
                if(!importAppState.players[pName]) {
                    importAppState.players[pName] = {}; 
                    importAppState.playerOrder.push(pName);
                }
            }
        });

        let labelCol = 0;
        for(let r = idx + 2; r < Math.min(idx + 15, lines.length); r++) {
            const rowData = parseCSVRow(lines[r]);
            if(rowData.some(cell => keysToExtract.includes(cell.trim()))) {
                labelCol = rowData.findIndex(cell => keysToExtract.includes(cell.trim()));
                break;
            }
        }

        for(let r = idx + 2; r < lines.length; r++) {
            const rowData = parseCSVRow(lines[r]);
            if(rowData.length < 2) continue; 
            
            const label = rowData[labelCol] ? rowData[labelCol].trim() : "";
            if(label === "" || label === "ADDITIONAL STATISTICS") continue;

            if(keysToExtract.includes(label)) {
                for(const [col, pName] of Object.entries(colMap)) {
                    const rawVal = rowData[col];
                    let val = 0;
                    if (label === "Teammates Revived") {
                        val = parseInt(rawVal) || 0;
                        importAppState.players[pName][label] = (importAppState.players[pName][label] || 0) + val;
                    } else {
                        val = parseFloat(rawVal.replace(/[^\d\.\-]/g, '')) || 0;
                        importAppState.players[pName][label] = (importAppState.players[pName][label] || 0) + val;
                    }
                }
                
                if(label !== "Teammates Revived") {
                        if(totalColIdx !== -1) {
                        const val = parseFloat(rowData[totalColIdx].replace(/[^\d\.\-]/g, '')) || 0;
                        importAppState.matrixTotals[label] = (importAppState.matrixTotals[label] || 0) + val;
                        }
                }
            }
        }
    };

    parseSection("SQUAD PERFORMANCE MATRIX", MATRIX_KEYS);
    parseSection("ADDITIONAL STATISTICS", ADD_STATS_KEYS);
}

function renderImportUI() {
    document.getElementById('results-container').classList.add('visible');

    const m = importAppState.mission;
    document.getElementById('mp-mission').textContent = m.name;
    document.getElementById('mp-diff').textContent = m.diff;
    document.getElementById('mp-waves').textContent = m.waves;
    document.getElementById('mp-obj').textContent = m.obj;
    document.getElementById('mp-gene').textContent = m.gene;
    document.getElementById('mp-arm').textContent = m.arm;

    const mod = importAppState.modifiers;
    // Updated to match new unique IDs
    document.getElementById('import-mod-kills').textContent = mod.kills;
    document.getElementById('import-mod-specials').textContent = mod.specials;
    document.getElementById('import-mod-incaps').textContent = mod.incaps;
    document.getElementById('import-mod-dmg').textContent = mod.dmg;
    document.getElementById('import-mod-gene').textContent = mod.gene;
    document.getElementById('import-mod-arm').textContent = mod.arm;
    document.getElementById('import-mod-obj').textContent = mod.obj;
    document.getElementById('import-mod-waves').textContent = mod.waves;

    if(document.getElementById('import-mod-tasks')) {
        document.getElementById('import-mod-tasks').textContent = mod.tasks || '-';
    }
    
    buildImportTable('matrix-table', MATRIX_KEYS);
    buildImportTable('stats-table', ADD_STATS_KEYS);
}

function buildImportTable(tableId, rowKeys) {
    const table = document.getElementById(tableId);
    table.innerHTML = '';
    
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML = `<th>METRIC</th>`;
    importAppState.playerOrder.forEach(p => {
        headRow.innerHTML += `<th>${p}</th>`;
    });
    headRow.innerHTML += `<th>TOTAL</th>`;
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rowKeys.forEach(key => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="row-label" style="text-align:right;">${key}</td>`;
        
        let rowSum = 0; 

        importAppState.playerOrder.forEach(p => {
            let val = importAppState.players[p] ? importAppState.players[p][key] : 0;
            if(val === undefined) val = 0;

            if(key === "Teammates Revived") {
                const revs = val;
                const incaps = importAppState.players[p] ? (importAppState.players[p]["Incapacitations"] || 0) : 0;
                const diff = revs - incaps;
                val = `${revs} <span style="font-size:0.8em; color:${diff >= 0 ? '#afffa6' : '#ff6600'}">(${diff >= 0 ? '+' : ''}${diff})</span>`;
                rowSum += revs; 
            } else if(typeof val === 'number') {
                rowSum += val;
                if(!Number.isInteger(val)) val = val.toFixed(1);
            }
            
            tr.innerHTML += `<td>${val}</td>`;
        });

        let totVal = "";
        if(key === "Teammates Revived") {
            const totalRevs = rowSum;
            const totalIncaps = importAppState.matrixTotals["Incapacitations"] || 0;
            const totalDiff = totalRevs - totalIncaps;
            totVal = `${totalRevs} <span style="font-size:0.8em; color:${totalDiff >= 0 ? '#afffa6' : '#ff6600'}">(${totalDiff >= 0 ? '+' : ''}${totalDiff})</span>`;
        } else {
            let t = importAppState.matrixTotals[key];
            if(t === undefined || t === null) t = rowSum; 
            
            if(typeof t === 'number') {
                totVal = Number.isInteger(t) ? t : t.toFixed(1);
            } else {
                totVal = t || 0;
            }
        }
        
        tr.innerHTML += `<td class="total-cell">${totVal}</td>`;
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
}

function openCopyModal() {
    if(!importAppState.playerOrder.length) return;
    
    let maxScore = -Infinity;
    let maxRanged = -Infinity;
    let maxMelee = -Infinity;
    let maxDiff = -Infinity;

    importAppState.playerOrder.forEach(name => {
        const s = importAppState.players[name];
        const diff = (s['Teammates Revived']||0) - (s['Incapacitations']||0);
        if((s['TOTAL SCORE']||0) > maxScore) maxScore = s['TOTAL SCORE'];
        if((s['Ranged Damage']||0) > maxRanged) maxRanged = s['Ranged Damage'];
        if((s['Melee Damage']||0) > maxMelee) maxMelee = s['Melee Damage'];
        if(diff > maxDiff) maxDiff = diff;
    });

    const squadScore = importAppState.matrixTotals['TOTAL SCORE'] || 0;
    let txt = `Total squad score: **${squadScore}**\n`;
    
    importAppState.playerOrder.forEach(name => {
        const stats = importAppState.players[name] || {};
        const tot = stats['TOTAL SCORE'] || 0;
        const ranged = stats['Ranged Damage'] || 0;
        const melee = stats['Melee Damage'] || 0;
        const incaps = stats['Incapacitations'] || 0;
        const revs = stats['Teammates Revived'] || 0;
        const diff = revs - incaps;

        const scoreStr = (tot === maxScore) ? `**${tot}**` : tot;
        const rangedStr = (ranged === maxRanged) ? `**${ranged}**` : ranged;
        const meleeStr = (melee === maxMelee) ? `**${melee}**` : melee;
        
        let diffVal = `${incaps}/${revs} (${diff >= 0 ? '+' : ''}${diff})`;
        if(diff === maxDiff) diffVal = `**${diffVal}**`;

        txt += `@${name} score: ${scoreStr} ; Ranged damage: ${rangedStr} ; Melee damage: ${meleeStr} ; Incapacitations/revives: ${diffVal}\n`;
    });

    document.getElementById('copy-text').value = txt;
    document.getElementById('copy-modal').classList.add('active');
}

function copySummaryText() {
    const el = document.getElementById('copy-text');
    el.select();
    el.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(el.value).then(() => {
        alert("Copied to clipboard!");
    });
}

// Function to download the Transmission Log as a .txt file
function downloadTransmissionLog() {
    const text = document.getElementById('copy-text').value;
    if (!text) {
        alert("No transmission data to save.");
        return;
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `Transmission_Log_${timestamp}.txt`;

    // Create blob and download link
    const blob = new Blob([text], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    
    // Trigger download
    document.body.appendChild(link);
    link.click();
    
    // Cleanup
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

/* ========================================================= */
/* ===  EXPORT LOGIC: TOP SECTION (Mission PNG)          === */
/* ========================================================= */

// This function is triggered directly by onclick="exportTopSectionPNG()"
async function exportTopSectionPNG() {
    // 1. Find the button to change text
    // We search by text content because we removed the ID reliance
    const allBtns = document.querySelectorAll('button');
    let btn = null;
    for (let b of allBtns) {
        if (b.innerText.includes("Export Mission")) {
            btn = b;
            break;
        }
    }
    
    const originalText = btn ? btn.innerText : "Export Mission (PNG)";
    if (btn) btn.innerText = "CAPTURING...";

    // 2. Select Elements
    const frame = document.querySelector('.cogitator-frame');
    const importWrapper = document.getElementById('import-wrapper');
    const dataBank = document.getElementById('data-bank-ui');
    const allBtnContainers = document.querySelectorAll('.export-buttons-container');

    // 3. Save States
    const originalImportDisplay = importWrapper ? importWrapper.style.display : '';
    const originalDataBankDisplay = dataBank ? dataBank.style.display : '';
    const originalFrameWidth = frame.style.width;
    const originalFrameMaxWidth = frame.style.maxWidth;
    const originalBodyWidth = document.body.style.width;
    const originalFrameHeight = frame.style.height;

    try {
        // 4. HIDE EVERYTHING WE DON'T WANT
        if (importWrapper) importWrapper.style.display = 'none';
        
        // Hide the data bank (saved missions) so it doesn't clutter the image
        if (dataBank) dataBank.style.display = 'none';

        // Hide ALL buttons (Top and Bottom)
        allBtnContainers.forEach(el => el.style.display = 'none');

        // 5. RESIZE FRAME (Force desktop width)
        document.body.style.width = '1120px';
        frame.style.width = '1100px';
        frame.style.maxWidth = 'none';
        frame.style.height = 'max-content'; 
        
        // Wait for browser to repaint
        await new Promise(resolve => setTimeout(resolve, 100));

        // 6. CAPTURE
        const canvas = await html2canvas(frame, {
            scale: 2, 
            backgroundColor: '#000000', 
            windowWidth: 1280, 
            useCORS: true
        });

        // 7. DOWNLOAD
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        link.download = `Mission_Summary_${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

    } catch (err) {
        console.error("Cogitator Error:", err);
        alert("Error generating pict-record. Check console.");
    } finally {
        // 8. RESTORE EVERYTHING
        if (importWrapper) importWrapper.style.display = originalImportDisplay;
        if (dataBank) dataBank.style.display = originalDataBankDisplay; // Restore Data Bank
        
        // Restore buttons
        allBtnContainers.forEach(el => el.style.display = 'flex');

        frame.style.width = originalFrameWidth;
        frame.style.maxWidth = originalFrameMaxWidth;
        frame.style.height = originalFrameHeight;
        document.body.style.width = originalBodyWidth;
        
        if (btn) btn.innerText = originalText;
    }
}

/* ========================================================= */
/* ===  GLOBAL UTILS: ESC KEY LISTENER                   === */
/* ========================================================= */

document.addEventListener('keydown', function(event) {
    // Check for "Escape" key
    if (event.key === "Escape") {
        
        // 1. Close OCR Modal
        const ocrModal = document.getElementById('ocr-modal-overlay');
        if (ocrModal && ocrModal.classList.contains('active')) {
            ocrModal.classList.remove('active');
        }

        // 2. Close Transmission Log
        const copyModal = document.getElementById('copy-modal');
        if (copyModal && copyModal.classList.contains('active')) {
            copyModal.classList.remove('active');
        }

        // 3. Close Saved Slot Modal
        const slotModal = document.getElementById('slot-modal-overlay');
        if (slotModal && slotModal.classList.contains('active')) {
            slotModal.classList.remove('active');
        }
    }
});

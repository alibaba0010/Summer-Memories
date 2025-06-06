import { type NextRequest, NextResponse } from "next/server";
import { analyzeMediaWithGemini, bufferToBase64 } from "@/lib/geminiVision";
import { getCategories } from "@/lib/category";
import calculatePhash from "sharp-phash";

import { createUserContent } from "@google/genai";
import { connectToDatabase } from "@/lib/mongodb";
import { MediaItemModel } from "@/lib/media";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const userId = formData.get("userId") as string;
    const type = formData.get("type") as "image" | "video";
    if (!file || !userId || !type) {
      return NextResponse.json(
        { message: "Missing required fields" },
        { status: 400 }
      );
    }

    // Fetch categories using the server-side function
    const userCategories = await getCategories(userId);
    const categoryNames = userCategories.map((cat) => cat.name); // Extract category names

    // Read file as buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = bufferToBase64(buffer);

    // Duplicate detection for images (using exact phash match)
    let phash: string | undefined = undefined;
    if (type === "image") {
      try {
        phash = await calculatePhash(buffer);

        // --- Duplicate Detection for Images (using phash) ---
        if (phash) {
          await connectToDatabase(); // Ensure DB connection
          // Find existing image items for this user with the same phash
          const existingItem = await MediaItemModel.findOne({
            userId,
            type: "image",
            phash: phash,
          });

          if (existingItem) {
            return NextResponse.json(
              {
                message:
                  "Warning: A very similar image already exists in your collection.",
                isDuplicate: true,
              },
              { status: 200 } // Use 200 OK but with a flag indicating a duplicate warning
            );
          }
        }
      } catch (e) {
        console.error("pHash error:", e);
      }
    }

    // Call Gemini Vision for labels and caption
    let aiLabels: string[] = [];
    let aiCaption = "";

    const promptText = `Analyze this ${type} and provide a short description and relevant categories from the following list: ${JSON.stringify(
      categoryNames
    )}. Please output the result as a JSON object with two keys: "description" (string) and "categories" (array of strings from the list provided). For example: { "description": "A photo of...", "categories": ["Nature", "Travel"] }. If no categories are relevant, the "categories" array should be empty.`;

    const mediaInputPart = {
      inlineData: {
        data: base64Data,
        mimeType: file.type,
      },
    };

    const contents = createUserContent([mediaInputPart, { text: promptText }]);

    try {
      const aiResultText = await analyzeMediaWithGemini(contents);

      // Attempt to parse the JSON response from Gemini
      if (aiResultText) {
        try {
          // Clean the string by removing markdown code block formatting if present
          let cleanResultText = aiResultText.trim();
          if (cleanResultText.startsWith("```json")) {
            cleanResultText = cleanResultText.substring("```json\n".length);
          }
          if (cleanResultText.endsWith("```")) {
            cleanResultText = cleanResultText.substring(
              0,
              cleanResultText.length - "```".length
            );
          }

          const resultJson = JSON.parse(cleanResultText);
          if (resultJson && typeof resultJson === "object") {
            if (typeof resultJson.description === "string") {
              aiCaption = resultJson.description;
            }
            if (Array.isArray(resultJson.categories)) {
              aiLabels = resultJson.categories.filter(
                (category: string) =>
                  typeof category === "string" &&
                  categoryNames.includes(category)
              );
            }
          }
        } catch (parseError) {
          console.error("Failed to parse Gemini JSON response:", parseError);
          // Fallback: if JSON parsing fails, treat the whole response as the caption
          aiCaption = aiResultText;
          aiLabels = []; // No labels if parsing fails
        }
      } else {
        // Handle cases where aiResultText is null or undefined
        aiCaption = "";
        aiLabels = [];
      }
    } catch (e) {
      console.error("Gemini Vision error:", e);
      // Set aiCaption and aiLabels to default values on error
      aiCaption = "";
      aiLabels = [];
    }

    return NextResponse.json(
      {
        message: "File processed for suggestions",
        suggestions: {
          categories: aiLabels,
          description: aiCaption,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    );
  }
}

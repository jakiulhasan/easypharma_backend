const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 4242;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_User}:${process.env.DB_Password}@cluster0.8gmleuq.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("EasyPharma");
    const medicinelist = db.collection("medicine_list");
    const inventoryList = db.collection("inventory_list");
    const buyHistory = db.collection("buyHistory_list");

    // ==================== MEDICINE ROUTES ====================

    // GET /api/medicines/search - Search medicines
    app.get("/api/medicines/search", async (req, res) => {
      try {
        const { q } = req.query;

        if (!q || q.length < 2) {
          return res.json([]);
        }

        const medicines = await medicinelist
          .find({
            name: { $regex: `^${q}`, $options: "i" },
          })
          .limit(10)
          .toArray();

        res.json(medicines);
      } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // GET /api/medicines/all-ids - Get all existing medicine IDs
    app.get("/api/medicines/all-ids", async (req, res) => {
      try {
        const medicines = await medicinelist.find({}).toArray();
        const ids = medicines.map((med) => med.id).filter((id) => id);
        res.json(ids);
      } catch (error) {
        console.error("Error fetching IDs:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/medicines - Create a new medicine
    app.post("/api/medicines", async (req, res) => {
      try {
        const { id, name, type, ...otherFields } = req.body;

        if (!id || !name) {
          return res.status(400).json({ error: "ID and Name are required" });
        }

        const existingMedicine = await medicinelist.findOne({ id: id });
        if (existingMedicine) {
          return res
            .status(400)
            .json({ error: "Medicine with this ID already exists" });
        }

        const existingByName = await medicinelist.findOne({
          name: { $regex: `^${name}$`, $options: "i" },
        });
        if (existingByName) {
          return res
            .status(400)
            .json({ error: "Medicine with this name already exists" });
        }

        const newMedicine = {
          id: id,
          name: name,
          type: type || "Tablet",
          code: id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await medicinelist.insertOne(newMedicine);

        res.status(201).json({
          ...newMedicine,
          _id: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating medicine:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/medicines/:id - Get single medicine by ID
    app.get("/api/medicines/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const medicine = await medicinelist.findOne({ id: id });

        if (!medicine) {
          return res.status(404).json({ error: "Medicine not found" });
        }

        res.json(medicine);
      } catch (error) {
        console.error("Error fetching medicine:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ==================== INVENTORY ROUTES ====================

    // POST /api/inventory/bulk-add - Add multiple items to inventory and buy history
    app.post("/api/inventory/bulk-add", async (req, res) => {
      try {
        const {
          inventoryItems,
          buyHistoryItems,
          user,
          commission,
          subTotal,
          grandTotal,
          purchaseDate,
        } = req.body;

        if (!inventoryItems || inventoryItems.length === 0) {
          return res.status(400).json({ error: "No inventory items provided" });
        }

        let inventoryCount = 0;
        let buyHistoryCount = 0;

        // Start a session for transaction
        const session = client.startSession();

        try {
          await session.withTransaction(async () => {
            // Add to inventory - using updateOne with upsert to handle existing items
            for (const item of inventoryItems) {
              const existingInventory = await inventoryList.findOne({
                medicineId: item.medicineId,
              });

              if (existingInventory) {
                // Update existing inventory - add quantity
                await inventoryList.updateOne(
                  { medicineId: item.medicineId },
                  {
                    $inc: { quantity: item.quantity },
                    $set: {
                      medicineName: item.medicineName,
                      type: item.type,
                      buyPrice: item.buyPrice,
                      sellPrice: item.sellPrice,
                      expiry: item.expiry,
                      location: item.location,
                      user: item.user,
                      updatedAt: new Date(),
                    },
                  },
                  { session },
                );
              } else {
                // Insert new inventory item
                await inventoryList.insertOne(
                  {
                    ...item,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                  { session },
                );
              }
              inventoryCount++;
            }

            // Add to buy history
            if (buyHistoryItems && buyHistoryItems.length > 0) {
              // Add purchase summary to each buy history item
              const buyHistoryWithSummary = buyHistoryItems.map((item) => ({
                ...item,
                purchaseSummary: {
                  subTotal,
                  commission,
                  grandTotal,
                  purchaseDate: purchaseDate || new Date(),
                },
                createdAt: new Date(),
              }));

              const buyHistoryResult = await buyHistory.insertMany(
                buyHistoryWithSummary,
                { session },
              );
              buyHistoryCount = buyHistoryResult.insertedCount;
            }
          });

          res.json({
            success: true,
            inventoryCount,
            buyHistoryCount,
            message: `Successfully added ${inventoryCount} items to inventory and ${buyHistoryCount} items to buy history`,
          });
        } finally {
          await session.endSession();
        }
      } catch (error) {
        console.error("Error in bulk add:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/inventory/all - Get all inventory items
    app.get("/api/inventory/all", async (req, res) => {
      try {
        const inventory = await inventoryList
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json(inventory);
      } catch (error) {
        console.error("Error fetching inventory:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/inventory - Get inventory with filters
    app.get("/api/inventory", async (req, res) => {
      try {
        const { user, location, medicineId } = req.query;
        let query = {};

        if (user) query.user = user;
        if (location) query.location = location;
        if (medicineId) query.medicineId = medicineId;

        const inventory = await inventoryList.find(query).toArray();
        res.json(inventory);
      } catch (error) {
        console.error("Error fetching inventory:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/inventory/low-stock - Get low stock items (quantity < threshold)
    app.get("/api/inventory/low-stock", async (req, res) => {
      try {
        const threshold = parseInt(req.query.threshold) || 10;
        const lowStockItems = await inventoryList
          .find({
            quantity: { $lt: threshold },
          })
          .toArray();
        res.json(lowStockItems);
      } catch (error) {
        console.error("Error fetching low stock items:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/inventory/expiring - Get expiring items
    app.get("/api/inventory/expiring", async (req, res) => {
      try {
        const days = parseInt(req.query.days) || 30;
        const today = new Date();
        const futureDate = new Date();
        futureDate.setDate(today.getDate() + days);

        const expiringItems = await inventoryList
          .find({
            expiry: {
              $gte: today.toISOString().split("T")[0],
              $lte: futureDate.toISOString().split("T")[0],
            },
          })
          .toArray();
        res.json(expiringItems);
      } catch (error) {
        console.error("Error fetching expiring items:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // PUT /api/inventory/:id - Update inventory item
    app.put("/api/inventory/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { quantity, buyPrice, sellPrice, expiry, location, type } =
          req.body;

        const result = await inventoryList.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              quantity,
              buyPrice,
              sellPrice,
              expiry,
              location,
              type,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Inventory item not found" });
        }

        const updatedItem = await inventoryList.findOne({
          _id: new ObjectId(id),
        });

        res.json({ success: true, data: updatedItem });
      } catch (error) {
        console.error("Error updating inventory:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // DELETE /api/inventory/:id - Remove inventory item
    app.delete("/api/inventory/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await inventoryList.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Inventory item not found" });
        }

        res.json({
          success: true,
          message: "Inventory item deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting inventory:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ==================== BUY HISTORY ROUTES ====================

    // GET /api/buy-history - Get buy history
    app.get("/api/buy-history", async (req, res) => {
      try {
        const { user, startDate, endDate, medicineId } = req.query;
        let query = {};

        if (user) query.user = user;
        if (medicineId) query.medicineId = medicineId;

        if (startDate || endDate) {
          query.purchaseDate = {};
          if (startDate) query.purchaseDate.$gte = new Date(startDate);
          if (endDate) query.purchaseDate.$lte = new Date(endDate);
        }

        const history = await buyHistory
          .find(query)
          .sort({ purchaseDate: -1 })
          .toArray();
        res.json(history);
      } catch (error) {
        console.error("Error fetching buy history:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/buy-history/summary - Get purchase summary by date range
    app.get("/api/buy-history/summary", async (req, res) => {
      try {
        const { startDate, endDate, user } = req.query;
        let matchStage = {};

        if (startDate || endDate) {
          matchStage.purchaseDate = {};
          if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
          if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
        }

        if (user) matchStage.user = user;

        const summary = await buyHistory
          .aggregate([
            { $match: matchStage },
            {
              $group: {
                _id: {
                  date: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$purchaseDate",
                    },
                  },
                  user: "$user",
                },
                totalPurchases: { $sum: 1 },
                totalQuantity: { $sum: "$quantity" },
                totalAmount: { $sum: "$totalPrice" },
                grandTotal: { $first: "$purchaseSummary.grandTotal" },
              },
            },
            { $sort: { "_id.date": -1 } },
          ])
          .toArray();

        res.json(summary);
      } catch (error) {
        console.error("Error fetching buy history summary:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ==================== DASHBOARD STATS ====================

    // GET /api/dashboard/stats - Get dashboard statistics
    app.get("/api/dashboard/stats", async (req, res) => {
      try {
        const totalMedicines = await medicinelist.countDocuments();
        const totalInventoryItems = await inventoryList.countDocuments();
        const totalQuantity = await inventoryList
          .aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }])
          .toArray();

        const lowStockItems = await inventoryList.countDocuments({
          quantity: { $lt: 10 },
        });

        res.json({
          totalMedicines,
          totalInventoryItems,
          totalQuantity: totalQuantity[0]?.total || 0,
          lowStockItems,
        });
      } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ error: error.message });
      }
    });

    console.log("All API routes configured successfully");
  } catch (error) {
    console.error("Database connection error:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("EasyPharma API Server is running!");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

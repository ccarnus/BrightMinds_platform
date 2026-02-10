// topic_indicator_computor.js

const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const Topic = require('../models/topic_model.js');

const isTestEnv = process.env.NODE_ENV === 'test';

// MongoDB connection
if (!isTestEnv) {
  mongoose.connect('mongodb+srv://ccarnus:totodu30@cast.xwxgb0o.mongodb.net/?retryWrites=true&w=majority')
    .then(() => {
      console.log('Successfully connected to MongoDB Atlas for topic indicator computor!');
      // Once connected, schedule the job and/or run an immediate update.
      scheduleWeeklyImpactUpdate();
      computeImpactForAllTopics();
    })
    .catch((error) => {
      console.error('Unable to connect to MongoDB Atlas', error);
    });
}

// Your SERP API key and base URL
const SERP_API_KEY = 'V8H3EVfy67HV5XijhqPRwaFy';
const SERP_BASE_URL = 'https://www.searchapi.io/api/v1/search';

/**
 * Computes and updates the impact and activity for a single topic.
 * It makes a GET request to the SERP API using the topic name as the query to obtain total_results.
 * If topic.openalexID is available, it makes a GET request to OpenAlex to get cited_by_count and works_count.
 * Then it computes:
 *   impact = (cited_by_count * 0.0001) + (total_results * 0.000001)
 *   activity = cited_by_count * 0.001
 *
 * @param {Object} topic - A Mongoose Topic document.
 * @returns {Promise<Object>} The updated topic document.
 */
async function computeImpactForTopic(topic) {
  try {
    // 1. SERP API call to get total_results
    const query = encodeURIComponent(topic.name);
    const serpUrl = `${SERP_BASE_URL}?engine=google&q=${query}&api_key=${SERP_API_KEY}`;
    const serpResponse = await axios.get(serpUrl);

    let totalResults = 0;
    if (
      serpResponse.data &&
      serpResponse.data.search_information &&
      typeof serpResponse.data.search_information.total_results !== 'undefined'
    ) {
      totalResults = serpResponse.data.search_information.total_results;
    } else {
      console.error(`Invalid SERP API response structure for topic "${topic.name}".`);
    }

    // 2. OpenAlex API call (if openalexID is present) to get cited_by_count and works_count
    let citedByCount = 0;
    if (topic.openalexID) {
      const openAlexUrl = `https://api.openalex.org/topics/${topic.openalexID}`;
      try {
        const openAlexResponse = await axios.get(openAlexUrl);
        if (openAlexResponse.data) {
          citedByCount = openAlexResponse.data.cited_by_count || 0;
          // works_count is returned but not directly used for computation, aside from activity if needed.
          // For activity, we use cited_by_count * 0.001 per your specification.
        }
      } catch (error) {
        console.error(`Error fetching OpenAlex data for topic "${topic.name}" with ID ${topic.openalexID}:`, error.message);
      }
    } else {
      console.warn(`No openalexID for topic "${topic.name}". Only using SERP total_results for impact calculation.`);
    }

    // 3. Compute impact and activity
    const impact = (citedByCount * 0.0001) + (totalResults * 0.000001);
    const activity = citedByCount * 0.001;

    // 4. Update the topic document
    topic.impact = impact;
    topic.activity = activity;
    await topic.save();

    console.log(`Updated topic "${topic.name}": impact = ${topic.impact}, activity = ${topic.activity}`);
    return topic;
  } catch (error) {
    console.error(`Error computing impact for topic "${topic.name}":`, error.message);
    return null;
  }
}

/**
 * Finds all topics and computes their impact value.
 *
 * @returns {Promise<void>}
 */
async function computeImpactForAllTopics() {
  try {
    const topics = await Topic.find();
    console.log(`Found ${topics.length} topic(s) for impact update.`);
    for (const topic of topics) {
      await computeImpactForTopic(topic);
    }
    console.log("Completed updating impact for all topics.");
  } catch (error) {
    console.error("Error computing impact for all topics:", error.message);
  }
}

/**
 * Schedules a job to update the impact value for all topics every Monday at midnight.
 * The cron pattern "0 0 * * 1" corresponds to "At 00:00 on Monday."
 */
function scheduleWeeklyImpactUpdate() {
  cron.schedule('0 0 * * 1', () => {
    console.log("Scheduled weekly impact update started...");
    computeImpactForAllTopics();
  });
  console.log("Weekly impact update scheduled for every Monday at midnight.");
}

module.exports = {
  computeImpactForTopic,
  computeImpactForAllTopics,
  scheduleWeeklyImpactUpdate,
};

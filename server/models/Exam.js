const mongoose = require("mongoose");
// imported mongoose

const {
    CAREER_TYPES,
    EXAM_TYPES,
} = require("../utils/discovery");
// Single source of truth for discovery enums/validators — canonical values
// are defined once in utils/discovery.js, never re-typed here.

const examSchema = new mongoose.Schema({
    name  : {
        type : String , 
        required : true ,
        trim : true ,
    } ,

    fullForm : {
        type : String , 
        required : true ,
        trim : true ,
    },

    streams : {
        type : [String] ,
        required : true ,
    } ,

    minimumEducationLevel : {
        type : String , 
        required : true ,
        trim : true ,
    } ,
    // NOTE (Phase 1): values in the dataset mix class levels ("8", "10",
    // "12") and "Graduate". They are stored as canonical strings (see
    // utils/educationLevels.js) and compared by numeric rank in
    // utils/eligibility.js — never with a Mongo string `$lte`.

    minimumAge : {
        type : Number ,
    } ,

    registrationStartDate : {
        type : Date,
        required : true 
    } , 
    registrationEndDate : {
        type : Date,
        required : true 
    } ,

    officialWebsite : {
        type : String , 
        required : true , 
        trim : true
    } ,

    description : {
        type : String , 
        trim : true
    },

    eligibility : {
        minimumPercentage : Number,
      
    } ,

    subjects : {
        type : [String] ,
        required : true ,
    } ,

    redditLinks : [String] ,

    quoraLinks : [String] ,

    // Phase 2 — MainPage discovery data (backend only, no discovery API yet).
    // Stream stays OUT: it belongs to the User profile / Phase 1 eligibility.
    // No month field: month relevance is derived from registrationStartDate /
    // registrationEndDate via examOverlapsMonth() in utils/discovery.js.
    careerType : {
        type : String ,
        enum : CAREER_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Optional on purpose: legacy documents predate this field, so absence is
    // allowed (treated as unclassified until the data-migration phase). Any
    // value that IS stored must be a valid enum member.

    examType : {
        type : String ,
        enum : EXAM_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Same backward-compatibility contract as careerType above.

} , {
    timestamps : true,
})

module.exports = mongoose.model("Exam" , examSchema);
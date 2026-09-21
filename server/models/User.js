const mongoose = require("mongoose");
// importing mongoose

const userSchema = new mongoose.Schema({
    name: {
        type : String,
        required : true,
        trim : true,
        minlength : 2,
        maxlength : 50,
    } ,
    email : {
       type: String,
       required: true,
       unique: true,
       lowercase: true,
       trim: true,
    } ,
    password :{
        type : String,
        required : true,
        minlength : 0,
    } ,

    // Google OAuth fields — only set when the user signs in via Google.
    // googleId: Google's unique ID for the account (audience/obfuscated sub).
    // avatar: profile picture URL returned by Google.
    googleId : {
        type : String ,
    },
    avatar : {
        type : String ,
    },

    // point to be noted is that password never stores the plain text password written by us, it stores the value of it , after hashing.
    // name , email and password are authentication information

    profile : {
        age : {
            type : Number ,
        } ,
        // Date of birth is the source of truth for the user's age.
        // The legacy numeric `age` above is kept only so older documents
        // still read; new writes go through `dateOfBirth` and eligibility
        // always derives age from it (see utils/eligibility.js).
        dateOfBirth : {
            type : Date ,
        } ,
        gender : {
            type : String ,
            trim : true ,
        } ,
        educationLevel : {
            type : String ,
        },
        percentage : {
            type : Number ,
        } ,
        stream: {
            type : String
        },
        subjects : [
            {
                type : String
            },
        ],
    },
    // Active profile architecture (Phase 1): age, educationLevel, stream,
    // percentage, subjects. Age is stored but optional for completeness.
    // educationLevel uses canonical strings (see utils/educationLevels.js).
    // careerInterests was removed: career type belongs to exam discovery,
    // not the user profile.
}, {
    timestamps: true
    // this was created so that, timstamps for when any of these
    // (email, password etc) , were being created and updated, that is being saved as :
    // createdAt
    // updatedAt
    
});

const User = mongoose.model('User', userSchema);
// creation of a model

module.exports = User;
// export User

// here model is User , which is generally written with a capslock.























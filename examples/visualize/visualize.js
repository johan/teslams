#!/usr/bin/env node
// create a local http server on port 8766 that visualizes the path of a Tesla Model S
// the data is taken from a MongoDB database
// the server can visualize / fast forward through past data in that database
// the client (as viewed in a browser) keeps updating real time until stopped
//
// You need a valid Google Maps v3 API key to use this script
//	https://developers.google.com/maps/documentation/javascript/tutorial#api_key
//
var apiKey = 'AIzaSyAtYQ9xjedv3B6_2HwsDVMY7oHlbNs-cvk';


function argchecker( argv ) {
	if (argv.db === true) throw 'MongoDB database name is unspecified. Use -d dbname or --db dbname';
}

var argv = require('optimist')
	.usage('Usage: $0 --db <MongoDB database> [--port <http listen port>] [--silent] [--verbose]')
	.check( argchecker )
	.alias('p', 'port')
	.describe('p', 'Listen port for the local http server')
	.default('p', 8766)
	.alias('d', 'db')
	.describe('d', 'MongoDB database name')
	.demand('d')
	.alias('s', 'silent')
	.describe('s', 'Silent mode: no output to console')
	.boolean(['s'])
	.alias('v', 'verbose')
	.describe('v', 'Verbose mode: more output to console')
	.boolean(['v'])
	.alias('?', 'help')
	.describe('?', 'Print usage information')
	.argv;
if ( argv.help === true ) {
	console.log( 'Usage: visualize.js --db <MongoDB database> [--silent] [--verbose]');
	process.exit(1);
}
var MongoClient = require('mongodb').MongoClient;
var date = new Date();
var http = require('http');
var fs = require('fs');
var lastTime = 0;
var started = false;
var to;
var capacity;
var express = require('express');
var app = express();
var passport = require('passport'), LocalStrategy = require('passport-local').Strategy;
var speedup = 60000;
var nav = "";

passport.use(new LocalStrategy(
	function(username, password, done) {
		User.findOne({ username: username }, function (err, user) {
			if (err) { return done(err); }
			if (!user) {
				return done(null, false, { message: 'Incorrect username.' });
			}
			if (!user.validPassword(password)) {
				return done(null, false, { message: 'Incorrect password.' });
			}
			return done(null, user);
		});
	}
));

fs.readFile(__dirname + "/otherfiles/nav.html", "utf-8", function(err, data) {
	if (err) throw err;
	nav = data;
});

function makeDate(string, offset) {
	var args = string.split('-');
	var date = new Date(args[0], args[1]-1, args[2], args[3], args[4], args[5]);
	if (offset !== undefined )
		date = new Date(date.getTime() + offset);
	return date;
}
function dateString(time) {
	return time.getFullYear() + '-' + (time.getMonth()+1) + '-' + time.getDate() + '-' +
		time.getHours() + '-' + time.getMinutes() + '-' + time.getSeconds();
}
function dashDate(date, filler) { // date-time with all '-'
	var c = date.replace('%20','-').replace(' ','-').split('-');
	for (var i = c.length; i < 6; i++)
		c.push(filler[i-3]);
	return c[0] + '-' + c[1] + '-' + c[2] + '-' + c[3] + '-' + c[4] + '-' + c[5];
}
function parseDates(fromQ, toQ) {
	if (toQ == undefined || toQ === null || toQ === "" || toQ.split('-').count < 2) // no valid to argument -> to = now
		this.toQ = dateString(new Date());
	else
		this.toQ = dashDate(toQ,['00','00','00']);
	if (fromQ == undefined || fromQ === null || fromQ === "" || fromQ.split('-').count < 2) // no valid from argument -> 12h before to
		this.fromQ = dashDate(dateString(makeDate(this.toQ, -12 * 3600 * 1000)));
	else
		this.fromQ = dashDate(fromQ,['23','59','59']);
}
MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
	// this is the first time we connect - if we get an error, just throw it
	if(err) throw(err);
	var collectionA = db.collection("tesla_aux");
	// get the last stored entry that describes the vehicles
	var query = {'vehicles': { '$exists': true } };
	var options = { 'sort': [['ts', 'desc']], 'limit': 1};
	collectionA.find(query, options).toArray(function(err, docs) {
		if (argv.verbose) console.dir(docs);
		if (docs.length === 0) {
			console.log("missing vehicles data in db, assuming Model S 60");
			capacity = 60;
		} else {
			if (docs.length > 1)
				console.log("congratulations, you have more than one Tesla Model S - this only supports your first car");
			var options = docs[0].vehicles.option_codes.split(',');
			for (var i = 0; i < options.length; i++) {
				if (options[i] == "BT85") {
					capacity = 85;
					break;
				}
				if (options[i] == "BT60") {
					capacity = 60;
					break;
				}
			}
		}
		if (argv.verbose) console.log("battery capacity", capacity);
	});
});

if (argv.verbose) app.use(express.logger('dev'));

app.get('/', function(req, res) {
	// friendly welcome screen
	fs.readFile(__dirname + "/welcome.html", "utf-8", function(err, data) {
		if (err) throw err;
		res.send(data.replace("MAGIC_NAV",nav));
	});
});

app.get('/getdata', function (req, res) {
	var ts, options, vals;
	console.log('/getdata with',req.query.at);
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		collection = db.collection("tesla_stream");
		if (req.query.at === null) {
			console.log("why is there no 'at' parameter???");
			return;
		}
		// get the data at time 'at'
		ts = +req.query.at;
		options = { 'sort': [['ts', 'desc']], 'limit': 1};
		collection.find({"ts": {"$lte": +ts}}, options).toArray(function(err,docs) {
			if (argv.verbose) console.log("got datasets:", docs.length);
			if (docs.length === 0) {
				// that shouldn't happen unless the database is empty...
				console.log("no data found for /getdata request at time", console.log(new Date(+ts).toString));
				return;
			}
			res.setHeader("Content-Type", "application/json");
			vals = docs[0].record.toString().replace(",,",",0,").split(",");
			console.dir(vals);
			res.write("[" + JSON.stringify(vals) + "]", "utf-8");
			res.end();
			db.close();
		});
	});
});

app.get('/storetrip', function(req, res) {
	MongoClient.connect("mongodb://127.0.0.01:27017/" + argv.db, function(err, db) {
		if (err) {
			console.log('error connecting to database:', err);
			return;
		}
		collection = db.collection("trip_data");
		collection.insert(req.query, { 'safe': true }, function(err,docs) {
			if (err) {
				res.send(err);
			} else {
				res.send("OK");
			}
		});
	});
});

app.get('/update', function (req, res) {
	// we don't keep the database connection as that has caused occasional random issues while testing
	if (!started)
		return;
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		collection = db.collection("tesla_stream");
		if (req.query.until === null) {
			console.log("why is there no 'until' parameter???");
			return;
		}
		// get the data until 'until'
		// but not past the end of the requested segment and not past the current time
		var endTime = +req.query.until;
		if (to && +endTime > +to)
			endTime = +to;
		var currentTime = new Date().getTime();
		if (+endTime > +currentTime)
			endTime = +currentTime;
		collection.find({"ts": {"$gt": +lastTime, "$lte": +endTime}}).toArray(function(err,docs) {
			if (argv.verbose) console.log("got datasets:", docs.length);
			if (docs.length === 0) {
				// create one dummy entry so the map app knows the last time we looked at
				docs = [ { "ts": +endTime, "record": [ +lastTime+"" ,"0","0","0","0","0","0","0","0","0","0","0"]} ];
			}
			res.setHeader("Content-Type", "application/json");
			res.write("[", "utf-8");
			var comma = "";
			docs.forEach(function(doc) {
				// the tesla streaming service replaces a few items with "" when the car is off
				// the reg exp below replaces the two that are numerical with 0 (the shift_state stays unchanged)
				var vals = doc.record.toString().replace(",,",",0,").split(",");
				res.write(comma + JSON.stringify(vals), "utf-8");
				lastTime = +doc.ts;
				comma = ",";
			});
			res.end("]", "utf-8");
			if (!argv.silent) {
				var showTime = new Date(lastTime);
				console.log("last timestamp:", lastTime, showTime.toString());
			}
			db.close();
		});
	});
});

app.get('/map', function(req, res) {
	var dates = new parseDates(req.query.from, req.query.to);
	from = makeDate(dates.fromQ);
	to = makeDate(dates.toQ);
	if (req.query.speed !== null && req.query.speed !== "" && req.query.speed <= 120 && req.query.speed >= 1)
		speedup = req.query.speed * 2000;
	if (req.query.to === undefined || req.query.to.split('-').length < 6 ||
	    req.query.from === undefined || req.query.from.split('-').length < 6) {
		var speedQ = speedup / 2000;
		res.redirect('/map?from=' + dates.fromQ + '&to=' + dates.toQ + '&speed=' + speedQ.toFixed(0));
		return;
	}
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		collection = db.collection("tesla_stream");
		var searchString = {$gte: +from, $lte: +to};
		collection.find({"ts": searchString}).limit(1).toArray(function(err,docs) {
			if (argv.verbose) console.log("got datasets:", docs.length);
			docs.forEach(function(doc) {
				var record = doc.record;
				var vals = record.toString().replace(",,",",0,").split(/[,\n\r]/);
				lastTime = +vals[0];
				res.setHeader("Content-Type", "text/html");
				fs.readFile(__dirname + "/map.html", "utf-8", function(err, data) {
					if (err) throw err;
					var response = data.replace("MAGIC_APIKEY", apiKey)
						.replace("MAGIC_FIRST_LOC", vals[6] + "," + vals[7])
						.replace("MAGIC_NAV", nav);
					res.end(response, "utf-8");
				});
			});
			db.close();
			started = true;
		});
	});
	if (!argv.silent) console.log('done sending the initial page');
});

app.get('/energy', function(req, res) {
	var path = req.path;
	var dates = new parseDates(req.query.from, req.query.to);
	from = makeDate(dates.fromQ);
	to = makeDate(dates.toQ);
	if (req.query.to === undefined || req.query.to.split('-').length < 6 ||
	    req.query.from === undefined || req.query.from.split('-').length < 6) {
		res.redirect('/energy?from=' + dates.fromQ + '&to=' + dates.toQ);
		return;
	}
	// don't deliver more than 10000 data points (that's one BIG screen)
	var halfIncrement =  Math.round((+to - +from) / 20000);
	var increment = 2 + halfIncrement;
	var outputE = "", outputS = "", outputSOC = "", outputRange = "", firstDate = 0, lastDate = 0;
	var minE = 1000, minS = 1000, minSOC = 1000;
	var maxE = -1000, maxS = -1000, maxSOC = -1000;
	var gMaxE = -1000, gMaxS = -1000;
	var gMinE = 1000, gMinS = 1000;
	var cumulE = 0, cumulR = 0, cumulES, cumulRS, prevTS;
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		var speed, energy, soc, vals;
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		res.setHeader("Content-Type", "text/html");
		collection = db.collection("tesla_stream");
		collection.find({"ts": {$gte: +from, $lte: +to}}).toArray(function(err,docs) {
			docs.forEach(function(doc) {
				vals = doc.record.toString().replace(",,",",0,").split(",");
				speed = parseInt(vals[1]);
				energy = parseInt(vals[8]);
				soc = parseInt(vals[3]);
				if (firstDate === 0) {
					firstDate = lastDate = prevTS = doc.ts;
					outputE = "[" + (+from) + ",0]";
					outputS = "[" + (+from) + ",0]";
					outputSOC = "[" + (+from) + "," + soc + "],null";
				}
				if (doc.ts >= lastDate) {
					if (doc.ts > lastDate + increment) {
						if (maxE != -1000) {
							outputE += ",[" + (+lastDate + halfIncrement) + "," + maxE + "]";
							outputE += ",[" + (+lastDate + increment) + "," + minE + "]";
						}
						if (maxS != -1000)
							outputS += ",[" + (+lastDate + halfIncrement) + "," + (+maxS + minS) / 2 + "]";
						if (maxSOC != -1000)
							outputSOC += ",[" + (+lastDate + halfIncrement)  + "," + (+maxSOC + minSOC) / 2 + "]";
						lastDate = doc.ts;
						if (+maxE > +gMaxE) gMaxE = maxE;
						if (+minE < +gMinE) gMinE = minE;
						if (+maxS > +gMaxS) gMaxS = maxS;
						maxE = maxS = maxSOC = -1000;
						minE = minS = minSOC = 1000;
					}
					if (energy > 0) cumulE += energy * (doc.ts - prevTS);
					if (energy < 0) cumulR += energy * (doc.ts - prevTS);
					if (energy > maxE) maxE = energy;
					if (energy < minE) minE = energy;
					if (speed > maxS) maxS = speed;
					if (speed < minS) minS = speed;
					if (soc > maxSOC) maxSOC = soc;
					if (soc < minSOC) minSOC = soc;
					prevTS = doc.ts;
				}
			});
			cumulE = cumulE / 3600000;
			cumulR = cumulR / 3600000;
			if (cumulE > 1) {
				cumulES = cumulE.toFixed(1) + "kWh";
				cumulRS = (-cumulR).toFixed(1) + "kWh";
			} else {
				cumulES = (cumulE * 1000).toFixed(0) + "Wh";
				cumulRS = (-cumulR * 1000).toFixed(0) + "Wh";
			}
			var chartEnd = lastDate;

			// now look for data in the aux collection

			collection = db.collection("tesla_aux");
			var maxAmp = 0, maxVolt = 0, maxMph = 0, maxPower = 0;
			var outputAmp = "", outputVolt = "", outputPower = "";
			var amp, volt, power;
			lastDate = +from;
			collection.find({"chargeState": {"$exists": true},
					 "ts": {$gte: +from, $lte: +to}}).toArray(function(err,docs) {
				if (argv.verbose) console.log("Found " + docs.length + " entries in aux DB");
				ouputAmp = "[" + (+firstDate) + ",0]";
				ouputVolt = "[" + (+firstDate) + ",0]";
				ouputPower = "[" + (+firstDate) + ",0]";
				comma = "";
				docs.forEach(function(doc) {
					amp = volt = 0;
					if(doc.chargeState.charging_state === 'Charging') {
						if (doc.chargeState.charger_actual_current !== undefined) {
							if (doc.chargeState.charger_actual_current !== 0) {
								amp = doc.chargeState.charger_actual_current;
							} else {
								amp = doc.chargeState.battery_current;
							}
							outputAmp += ",[" + doc.ts + "," + amp + "]";
							lastDate = doc.ts;
						}
						if (doc.chargeState.charger_voltage !== undefined) {
							volt = doc.chargeState.charger_voltage;
							outputVolt += ",[" + doc.ts + "," + volt + "]";
							lastDate = doc.ts;
						}
						if (lastDate == doc.ts) { // we had valid values
							power = parseFloat(volt) * parseFloat(amp) / 1000;
							outputPower += ",[" + doc.ts + "," + power.toFixed(1) + "]";
							if (power > maxPower) {
								maxPower = power;
								maxAmp = amp;
								maxVolt = volt;
								maxMph = doc.chargeState.charge_rate;
							}
						}
					} else if (doc.chargeState.charging_state === 'Disconnected' ||
						   doc.chargeState.charging_state === 'Complete' ||
						   doc.chargeState.charging_state === 'Pending' ||
						   doc.chargeState.charging_state === 'Starting' ||
						   doc.chargeState.charging_state === 'Stopped') {
						outputAmp += ",[" + doc.ts + ",0]";
						outputVolt += ",[" + doc.ts + ",0]";
						outputPower += ",[" + doc.ts + ",0]";
					}
					if (doc.chargeState.battery_range !== undefined) {
						outputRange += comma + "[" + doc.ts + "," + doc.chargeState.battery_range + "]";
						comma = ",";
					}
				});
				outputAmp += ",[" + (lastDate + 60000) + ",0]";
				outputVolt += ",[" + (lastDate + 60000) + ",0]";
				outputPower += ",[" + (lastDate + 60000) + ",0]";
				outputAmp += ",[" + (+chartEnd) + ",0]";
				outputVolt += ",[" + (+chartEnd) + ",0]";
				outputPower += ",[" + (+chartEnd) + ",0]";

				db.close();
				fs.readFile(__dirname + "/energy.html", "utf-8", function(err, data) {
					if (err) throw err;
					var fD = new Date(firstDate);
					var startDate = (fD.getMonth() + 1) + "/" + fD.getDate() + "/" + fD.getFullYear();
					gMinE = +gMinE - 10;
					gMaxE = +gMaxE + 10;
					if (2 * gMaxS > +gMaxE) {
						gMaxS = +gMaxS + 5;
						gMaxE = 2 * gMaxS;
					} else {
						gMaxS = gMaxE / 2;
					}
					gMinS = gMinE / 2;
					var response = data.replace("MAGIC_NAV", nav)
						.replace("MAGIC_ENERGY", outputE)
						.replace("MAGIC_SPEED", outputS)
						.replace("MAGIC_SOC", outputSOC)
						.replace("MAGIC_START", startDate)
						.replace("MAGIC_MAX_ENG", gMaxE)
						.replace("MAGIC_MIN_ENG", gMinE)
						.replace("MAGIC_MAX_SPD", gMaxS)
						.replace("MAGIC_MIN_SPD", gMinS)
						.replace("MAGIC_CUMUL_E", cumulES)
						.replace("MAGIC_CUMUL_R", cumulRS)
						.replace("MAGIC_VOLT", outputVolt)
						.replace("MAGIC_AMP", outputAmp)
						.replace("MAGIC_POWER", outputPower)
						.replace("MAGIC_RANGE", outputRange)
						.replace("MAGIC_MAX_VOLT", maxVolt)
						.replace("MAGIC_MAX_AMP", maxAmp)
						.replace("MAGIC_MAX_KW", maxPower.toFixed(1))
						.replace("MAGIC_MAX_MPH", maxMph)
						.replace("MAGIC_CAPACITY", capacity);
					res.end(response, "utf-8");
					if (argv.verbose) console.log("delivered", outputSOC.length,"records and", response.length, "bytes");
				});
			});
		});
	});
});

function countCharge(ts) {
	if (!countCharge.start)
		countCharge.start = ts;
}
function stopCountingCharge(ts) {
	if (countCharge.start && ts - countCharge.start > 60000) // at least a minute
		countCharge.chargeInt.push([countCharge.start,ts]);
	countCharge.start = null;
}
function countVamp(ts) {
	if (!countVamp.start)
		countVamp.start = ts;
}
function stopCountingVamp(ts) {
	if (countVamp.start && ts - countVamp.start > 60000) // at least a minute
		countVamp.vampInt.push([countVamp.start,ts]);
	countVamp.start = null;
}
function calculateDelta(d1, d2) {
	var cS1 = d1.chargeState, cS2 = d2.chargeState;
	if (!cS1 || !cS2 || !cS1.battery_level || !cS2.battery_level || cS2.battery_range > cS1.battery_range) {
		return 0;
	}
	// var ratedWh = 5 * ((cS1.battery_level * capacity / cS1.battery_range) + (cS2.battery_level * capacity / cS2.battery_range));
	// let's use the data that we seem to are converging on in the forums instead:
	var ratedWh = (capacity == 85) ? 286 : 267;
	var delta = ratedWh * (cS1.battery_range - cS2.battery_range);
//	if (argv.verbose) { // great for debugging
//		console.log(new Date(d1.ts), new Date(d2.ts), "ratedWh", ratedWh.toFixed(1),
//			    "delta range", (cS1.battery_range - cS2.battery_range).toFixed(1) ,"delta", delta.toFixed(1));
//	}
	return delta / 1000;
}
app.get('/test', function(req, res) {
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		var output = "";
		var collection = db.collection("tesla_aux");
		var options = { 'sort': [['chargeState.battery_range', 'desc']] };
		collection.find({"chargeState": {$exists: true}}).toArray(function(err,docs) {
			var comma = "";
			docs.forEach(function(doc) {
				if (doc.chargeState.battery_level !== undefined) {
					output += comma + "\n[" + doc.chargeState.battery_level + "," + doc.chargeState.battery_range + "]";
					comma = ',';
				}
			});
			db.close();
			fs.readFile(__dirname + "/test.html", "utf-8", function(err, data) {
				if (err) throw err;
				res.send(data.replace("MAGIC_TEST", output))
			});
		});
	});
});
app.get('/stats', function(req, res) {
	var path = req.path;
	var dates = new parseDates(req.query.from, req.query.to);
	countVamp.vampInt = [];
	countCharge.chargeInt = [];
	countVamp.start = null;
	from = makeDate(dates.fromQ);
	to = makeDate(dates.toQ);
	if (req.query.to === undefined || req.query.to.split('-').length < 6 ||
	    req.query.from === undefined || req.query.from.split('-').length < 6) {
		res.redirect('/stats?from=' + dates.fromQ + '&to=' + dates.toQ);
		return;
	}
	var outputD = "", outputC = "", outputA = "", outputW = "", comma, firstDate = 0, lastDay = 0, lastDate = 0;
	MongoClient.connect("mongodb://127.0.0.1:27017/" + argv.db, function(err, db) {
		if(err) {
			console.log('error connecting to database:', err);
			return;
		}
		res.setHeader("Content-Type", "text/html");
		collection = db.collection("tesla_stream");
		collection.find({"ts": {$gte: +from, $lte: +to}}).toArray(function(err,docs) {
			var vals = [];
			var odo, energy, state, soc;
			var dist, kWh, ts, midnight;
			var startOdo, charge, minSOC, maxSOC, increment, kWs;
			docs.forEach(function(doc) {
				var day = new Date(doc.ts).getDay();
				vals = doc.record.toString().replace(",,",",0,").split(",");
				odo = parseFloat(vals[2]);
				soc = parseFloat(vals[3]); // sadly, this is an integer today :-(
				energy = parseInt(vals[8]);
				state = vals[9];
				if (firstDate === 0) {
					firstDate = doc.ts;
					lastDay = day;
					startOdo = odo;
					minSOC = 101; maxSOC = -1; kWs = 0; charge = 0; increment = 0; comma = "";
				}
				if (doc.ts > lastDate) { // we don't want to go back in time
					if (day != lastDay) {
						lastDay = day;
						stopCountingVamp(lastDate);
						stopCountingCharge(lastDate);
						charge += increment * capacity / 100;
						dist = odo - startOdo;
						kWh = kWs / 3600;
						ts = new Date(lastDate);
						midnight = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate(), 0, 0, 0);
						outputD += comma + "[" + (+midnight)  + "," + dist + "]";
						outputC += comma + "[" + (+midnight)  + "," + charge + "]";
						if (dist > 0) {
							outputA += comma + "[" + (+midnight)  + "," + 1000 * kWh / dist + "]";
						} else {
							outputA += comma + "null";
						}
						outputW += comma + "[" + (+midnight) + "," + kWh + "]";
						startOdo = odo;
						minSOC = 101; maxSOC = -1; kWs = 0; charge = 0; increment = 0; comma = ",";
					}
					// this is crude - it would be much better to get this from
					// the aux database and use the actual charge info
					if (state != 'R' && state != 'D') { // we are not driving
						if (energy < 0) { // parked & charging
							stopCountingVamp(doc.ts);
							countCharge(doc.ts);
							if (soc < minSOC) minSOC = soc;
							if (soc > maxSOC) maxSOC = soc;
							increment = maxSOC - minSOC;
						} else { // parked & consuming
							countVamp(doc.ts);
							stopCountingCharge(doc.ts);
							// if we were charging before, add the estimate to the total
							// this a quite coarse as SOC is in full percent - bad granularity
							if (increment > 0) {
								charge += increment * capacity / 100;
								increment = 0; minSOC = 101; maxSOC = -1;
							}
						}
					} else {
						// we're driving - add up the energy used / regen
						if (lastDate > 0)
							kWs += (doc.ts - lastDate) / 1000 * (energy - 0.12); // this correction is needed to match in car data???
						stopCountingVamp(doc.ts);
					}
					lastDate = doc.ts;
				}
			});

			// we still need to add the last day

			stopCountingVamp(lastDate);
			stopCountingCharge(lastDate);
			charge += increment * capacity / 100;
			dist = odo - startOdo;
			kWh = kWs / 3600;
			ts = new Date(lastDate);
			midnight = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate(), 0, 0, 0);
			outputD += comma + "[" + (+midnight)  + "," + dist + "]";
			outputC += comma + "[" + (+midnight)  + "," + charge + "]";
			if (dist > 0) {
				outputA += comma + "[" + (+midnight)  + "," + 1000 * kWh / dist + "]";
			} else {
				outputA += comma + "null";
			}
			outputW += comma + "[" + (+midnight) + "," + kWh + "]";

			// now analyze the charging data
			collection = db.collection("tesla_aux");
			collection.find({"chargeState": {$exists: true}, "ts": {$gte: +from, $lte: +to}}).toArray(function(err,docs) {
				var i = 0, vampirekWh = 0, day, lastDay = -1, lastDate = null, comma = "", outputY = "";
				var j = 0, chargekWh = 0, outputCN = "";
				var vState1 = null;
				var cState1 = null;
				var lastDoc;
				var maxI = countVamp.vampInt.length;
				var maxJ = countCharge.chargeInt.length;
				docs.forEach(function(doc) {
					day = new Date(doc.ts).getDay();
					if (!doc || !doc.chargeState || !doc.chargeState.battery_level)
						return;
					lastDoc = doc;
					if (day != lastDay) {
						if (lastDate) {
							if (vState1) {
								vampirekWh += calculateDelta(vState1, doc);
								vState1 = doc;
							}
							if (cState1) {
								chargekWh += calculateDelta(doc, cState1);
								cState1 = doc;
							}
							ts = new Date(lastDate);
							midnight = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate(), 0, 0, 0);
							outputY += comma + "[" + midnight.getTime() + "," + vampirekWh + "]";
							outputCN += comma + "[" + midnight.getTime() + "," + chargekWh + "]";
							comma = ",";
						}
						lastDate = doc.ts;
						lastDay = day;
						vampirekWh = 0;
						chargekWh = 0;
					}
					if (i < maxI && vState1 === null && doc.ts >= countVamp.vampInt[i][0])
						vState1 = doc;
					if (i < maxI && doc.ts >= countVamp.vampInt[i][1]) {
						vampirekWh += calculateDelta(vState1, doc);
						vState1 = null;
						i++;
					}
					if (j < maxJ && cState1 === null && doc.ts >= countCharge.chargeInt[j][0])
						cState1 = doc;
					if (j < maxJ && doc.ts >= countCharge.chargeInt[j][1]) {
						chargekWh += calculateDelta(doc, cState1);
						cState1 = null;
						j++;
					}
				});
				if (vState1) {
					vampirekWh += calculateDelta(vState1, lastDoc);
				}
				if (cState1) {
					chargekWh += calculateDelta(doc, cState1);
				}
				ts = new Date(lastDate);
				midnight = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate(), 0, 0, 0);
				outputY += comma + "[" + midnight.getTime() + "," + vampirekWh + "]";
				outputCN += comma + "[" + midnight.getTime() + "," + chargekWh + "]";
				db.close();
				fs.readFile(__dirname + "/stats.html", "utf-8", function(err, data) {
					if (err) throw err;
					var fD = new Date(firstDate);
					var startDate = (fD.getMonth() + 1) + "/" + fD.getDate() + "/" + fD.getFullYear();
					var response = data
						.replace("MAGIC_NAV", nav)
						.replace("MAGIC_DISTANCE", outputD)
						.replace("MAGIC_CHARGE", outputCN)
						.replace("MAGIC_AVERAGE", outputA)
						.replace("MAGIC_KWH", outputW)
						.replace("MAGIC_VKWH", outputY)
						.replace("MAGIC_START", startDate);
					res.end(response, "utf-8");
				});

			});
		});
	});
});

app.get('/trip', function(req, res) {
	res.setHeader("Content-Type", "text/html");
	fs.readFile(__dirname + "/trip.html", "utf-8", function(err, data) {
		if (err) throw err;
		res.end(data.replace("MAGIC_NAV", nav), "utf-8");
	});
});

// that's all it takes to deliver the static files in the otherfiles subdirectory
app.use(express.static(__dirname + '/otherfiles'));

app.listen(argv.port);

if (!argv.silent) console.log("Server running on port " + argv.port);

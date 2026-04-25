import ee

ee.Initialize(project='h2oolkit-hackathon')

point = ee.Geometry.Point([26.5, 45.2])
print("Connection successful!")
print("Test point:", point.getInfo())
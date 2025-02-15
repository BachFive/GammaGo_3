# tag::e2e_imports[]
import h5py
from keras.layers import Dense
from keras.models import Sequential

from dlgo.data.parallel_processor import GoDataProcessor
from dlgo.encoders.sevenplane import SevenPlaneEncoder
from dlgo.httpfrontend import get_web_app
from dlgo.networks import large
from dlgo.agent.predict import *

# end::e2e_imports[]

# tag::e2e_processor[]
go_board_rows, go_board_cols = 19, 19
nb_classes = go_board_rows * go_board_cols
encoder = SevenPlaneEncoder((go_board_rows, go_board_cols))
processor = GoDataProcessor(encoder=encoder.name())

X, y = processor.load_go_data(num_samples=1)
# end::e2e_processor[]

# tag::e2e_model[]
input_shape = (encoder.num_planes, go_board_rows, go_board_cols)
model = Sequential()
network_layers = large.layers(input_shape)
for layer in network_layers:
    model.add(layer)
model.add(Dense(nb_classes, activation='softmax'))
model.compile(loss='categorical_crossentropy', optimizer='adadelta', metrics=['accuracy'])

model.fit(X, y, batch_size=128, epochs=1, verbose=1)
# end::e2e_model[]

# tag::e2e_agent[]
deep_learning_bot = DeepLearningAgent(model, encoder)
with h5py.File('../agents/deep_bot.h5', 'w') as f:
    deep_learning_bot.serialize(f)
# deep_learning_bot = load_prediction_agent(h5py.File("../agents/deep_bot.h5", "r"))
# bot = load_prediction_agent(h5py.File("../agents/deep_bot.h5", "r"))
# end::e2e_agent[]

# tag::e2e_load_agent[]
model_file = h5py.File("../agents/deep_bot.h5", "r")
bot_from_file = load_prediction_agent(model_file)

web_app = get_web_app({'predict': bot_from_file})
web_app.run()
# end::e2e_load_agent[]
